import { Response } from "express";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import {
    RequestWithAuth,
    type OwnerContext,
    createMonitorSchema,
    updateMonitorSchema,
    prepareMonitorUpdate,
    buildMonitorTaskPayload,
    config,
    appConfig,
    getPlanLimits,
    checkPlanFeatures,
    cronIntervalMinutes,
    type PlanLimits,
    resolveTrackMode,
    estimateTaskCredits,
    normalizePagination,
    log,
} from "@anycrawl/libs";
import {
    getDB,
    updateOwnedMonitor,
    deleteOwnedMonitor,
    encodeMonitorCursor,
    MonitorCursorError,
    listMonitorCheckHistory,
    listMonitorNotificationHistory,
    withDatabaseTransaction,
    type DatabaseSteps,
    schemas,
    eq,
    sql,
    getOwnedMonitor,
    listMonitorsByOwner,
    countMonitorsByOwner,
    listSnapshotsByMonitor,
    getSnapshotForMonitor,
    listChangesByMonitor,
    listChangesByOwner,
} from "@anycrawl/db";
import { randomUUID } from "crypto";
import { serializeRecord, serializeRecords } from "../../utils/serializer.js";

export class MonitorController {
    /**
     * Create a monitor. Creates a backing scheduled_task (1:1) and a monitors row.
     */
    public create = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const validated = createMonitorSchema.parse(req.body);
            const owner = this.getOwnerContext(req);
            const { apiKeyId, userId } = owner;

            // MVP: single target. Additional targets are accepted but only the first is scheduled.
            const target = validated.targets[0];
            const trackMode = resolveTrackMode(validated.monitor_type, validated.track_mode);
            const taskPayload = buildMonitorTaskPayload(
                target,
                trackMode,
                validated.extract_schema,
                validated.goal,
                validated.diff_options
            );

            const minCreditsRequired = estimateTaskCredits("scrape", taskPayload);
            const nextExecution = this.calculateNextExecution(
                validated.cron_expression,
                validated.timezone
            );
            // A monitor stored without a computable next execution would never run —
            // fail loudly instead of returning 201 with next_execution_at: undefined.
            if (!nextExecution) {
                res.status(400).json({
                    success: false,
                    error: "cron_expression and timezone produced no future execution time",
                });
                return;
            }

            const db = await getDB();

            // Plan gates. No-op unless auth AND plan limits are both on, so a
            // self-hosted install can run any number of monitors at any frequency.
            if (appConfig.authEnabled && config.auth.planLimitsEnabled) {
                const limits = getPlanLimits(req.auth?.subscriptionTier);
                // Every target, not just the scheduled one: MAX_TARGETS is 50 and the
                // others are still stored and will run once multi-target ships.
                const violation = this.checkTargets(validated.targets, limits);
                if (violation) {
                    res.status(403).json({ success: false, error: violation.code, message: violation.message });
                    return;
                }
                if (Number.isFinite(limits.monitors)) {
                    const existing = await countMonitorsByOwner(db, owner);
                    if (existing >= limits.monitors) {
                        res.status(403).json({
                            success: false,
                            error: "Monitor limit reached",
                            message: `Your plan allows ${limits.monitors} monitor${limits.monitors === 1 ? "" : "s"}. Delete one or upgrade your plan.`,
                            limit: limits.monitors,
                        });
                        return;
                    }
                }
                const intervalMinutes = cronIntervalMinutes(validated.cron_expression);
                if (intervalMinutes !== null && intervalMinutes < limits.minMonitorIntervalMinutes) {
                    res.status(403).json({
                        success: false,
                        error: "Check frequency too high for your plan",
                        message: `Your plan allows a check every ${limits.minMonitorIntervalMinutes} minutes at most.`,
                        min_interval_minutes: limits.minMonitorIntervalMinutes,
                    });
                    return;
                }
            }

            const scheduledTaskUuid = randomUUID();
            const monitorUuid = randomUUID();

            // Task + monitor rows must land together: a task without its monitor row
            // would keep firing and billing while being invisible in both UIs (the
            // scheduled-tasks list hides monitor-managed rows).
            await withDatabaseTransaction(db, function* (tx: any): DatabaseSteps<void> {
                // 1. Backing scheduled task
                yield tx.insert(schemas.scheduledTasks).values({
                    uuid: scheduledTaskUuid,
                    apiKey: apiKeyId,
                    userId: userId || null,
                    name: `[monitor] ${validated.name}`,
                    description: validated.description,
                    cronExpression: validated.cron_expression,
                    timezone: validated.timezone,
                    taskType: "scrape",
                    taskPayload,
                    concurrencyMode: validated.concurrency_mode,
                    maxExecutionsPerDay: validated.max_executions_per_day,
                    minCreditsRequired,
                    isActive: true,
                    isPaused: false,
                    nextExecutionAt: nextExecution,
                    tags: validated.tags,
                    metadata: { ...(validated.metadata ?? {}), monitorManaged: true, monitorUuid },
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });

                // 2. Monitor row
                yield tx.insert(schemas.monitors).values({
                    uuid: monitorUuid,
                    apiKey: apiKeyId,
                    userId: userId || null,
                    name: validated.name,
                    description: validated.description,
                    monitorType: validated.monitor_type,
                    scheduledTaskUuid,
                    targets: validated.targets,
                    goal: validated.goal,
                    trackMode,
                    extractSchema: validated.extract_schema ?? null,
                    diffOptions: validated.diff_options ?? null,
                    notifyOptions: validated.notify_options ?? { channels: ["webhook"], only_meaningful: true },
                    isActive: true,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });
            });

            // 3. Register the recurring cron and trigger the first check immediately,
            //    so a newly created monitor produces a baseline snapshot right away
            //    instead of waiting for the first cron slot. triggerTaskNow enqueues
            //    onto the shared Redis "scheduler" queue, so it works even when the
            //    scheduler runs as a separate worker image (this API process does not
            //    run the scheduler in-process).
            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                const scheduler = SchedulerManager.getInstance();
                const createdTask = await db
                    .select()
                    .from(schemas.scheduledTasks)
                    .where(eq(schemas.scheduledTasks.uuid, scheduledTaskUuid))
                    .limit(1);
                if (createdTask.length > 0) {
                    // When the scheduler runs in this process, register the repeatable
                    // cron now; otherwise the separate worker picks it up via polling.
                    if (scheduler.isSchedulerRunning()) {
                        await scheduler.addScheduledTask(createdTask[0]);
                    }
                    // Immediate first check — but only when a scheduler worker is
                    // actually consuming the queue. Enqueueing without a consumer
                    // would strand the job until a scheduler starts, then fire it
                    // at an arbitrary later time. The cron registration above (or
                    // worker polling) still covers the recurring schedule.
                    if (await scheduler.hasSchedulerConsumer()) {
                        await scheduler.triggerTaskNow(createdTask[0]);
                    } else {
                        log.debug("Monitor created without immediate first check: no scheduler consumer detected.");
                    }
                }
            } catch (error) {
                log.warning(`Failed to schedule/trigger monitor task: ${error}`);
            }

            res.status(201).json({
                success: true,
                data: {
                    monitor_id: monitorUuid,
                    scheduled_task_id: scheduledTaskUuid,
                    track_mode: trackMode,
                    next_execution_at: nextExecution?.toISOString(),
                },
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * List monitors for the authenticated owner
     */
    public list = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const monitors = await listMonitorsByOwner(db, owner);
            res.json({ success: true, data: serializeRecords(monitors) });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Cross-monitor change feed for the authenticated owner. Powers the dashboard
     * "Changes" inbox: every detected change across all of the owner's monitors,
     * newest first. Optional ?change_type= filters by change type.
     *
     * Route registration note: this must be wired BEFORE GET /monitors/:id or
     * Express captures "changes" as an :id.
     */
    public changesFeed = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const { limit, offset } = normalizePagination(
                req.query.limit as string | undefined,
                req.query.offset as string | undefined,
                { defaultLimit: 50, maxLimit: 200 }
            );
            const changeType = z.enum(["content", "text", "price_up", "price_down", "stock", "new", "removed"]).optional().parse(req.query.change_type);
            const cursor = z.string().optional().parse(req.query.cursor);
            const rows = await listChangesByOwner(db, owner, offset, limit + 1, { changeType, cursor });
            this.sendPage(res, rows, limit);
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Get one monitor
     */
    public get = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const id = z.string().uuid().parse(req.params.id);
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }
            res.json({ success: true, data: serializeRecord(monitor) });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Update a monitor. Propagates cron/payload-affecting changes to the backing task.
     */
    public update = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const id = z.string().uuid().parse(req.params.id);
            const owner = this.getOwnerContext(req);
            const validated = updateMonitorSchema.parse(req.body);
            const db = await getDB();

            // Same gates as create. Without these a monitor could be created within
            // plan and then patched straight past it.
            if (appConfig.authEnabled && config.auth.planLimitsEnabled) {
                const limits = getPlanLimits(req.auth?.subscriptionTier);
                const violation = this.checkTargets(validated.targets, limits);
                if (violation) {
                    res.status(403).json({ success: false, error: violation.code, message: violation.message });
                    return;
                }
                if (validated.cron_expression) {
                    const intervalMinutes = cronIntervalMinutes(validated.cron_expression);
                    if (intervalMinutes !== null && intervalMinutes < limits.minMonitorIntervalMinutes) {
                        res.status(403).json({
                            success: false,
                            error: "Check frequency too high for your plan",
                            message: `Your plan allows a check every ${limits.minMonitorIntervalMinutes} minutes at most.`,
                            min_interval_minutes: limits.minMonitorIntervalMinutes,
                        });
                        return;
                    }
                }
            }

            const task = await updateOwnedMonitor(db, id!, owner, (monitor, backingTask) => prepareMonitorUpdate(monitor, backingTask, validated));
            if (!task) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }
            await this.syncTask(task);

            const updated = await getOwnedMonitor(db, id!, owner);
            res.json({ success: true, data: serializeRecord(updated) });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Delete a monitor and its backing scheduled task (cascade removes snapshots/changes).
     */
    public delete = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const id = z.string().uuid().parse(req.params.id);
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }

            await deleteOwnedMonitor(db, id, owner);

            if (monitor.scheduledTaskUuid) {
                try {
                    const { SchedulerManager } = await import("@anycrawl/scrape");
                    await SchedulerManager.getInstance().removeScheduledTask(monitor.scheduledTaskUuid);
                } catch (error) {
                    log.warning(`Failed to remove monitor task from scheduler: ${error}`);
                }
            }

            res.json({ success: true, message: "Monitor deleted successfully" });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Pause monitoring (pauses the backing scheduled task).
     */
    public pause = async (req: RequestWithAuth, res: Response): Promise<void> => {
        await this.setActive(req, res, false);
    };

    public resume = async (req: RequestWithAuth, res: Response): Promise<void> => {
        await this.setActive(req, res, true);
    };

    private async setActive(req: RequestWithAuth, res: Response, isActive: boolean): Promise<void> {
        try {
            const id = z.string().uuid().parse(req.params.id);
            const owner = this.getOwnerContext(req);
            const db = await getDB();
            const task = await updateOwnedMonitor(db, id, owner, (monitor, backingTask) => prepareMonitorUpdate(monitor, backingTask, { is_active: isActive }));
            if (!task) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }
            await this.syncTask(task);
            res.json({ success: true, message: `Monitor ${isActive ? "resumed" : "paused"} successfully`, data: serializeRecord(await getOwnedMonitor(db, id, owner)) });
        } catch (error) { this.handleError(error, res); }
    }

    private async syncTask(task: any): Promise<void> {
        try {
            const { SchedulerManager } = await import("@anycrawl/scrape");
            const scheduler = SchedulerManager.getInstance();
            if (task.isPaused || !task.isActive) await scheduler.removeScheduledTask(task.uuid);
            else if (scheduler.isSchedulerRunning()) await scheduler.addScheduledTask(task);
        } catch (error) {
            // The scheduler polls persisted updatedAt; the committed state remains
            // authoritative when Redis is temporarily unavailable.
            log.warning(`Monitor schedule will be reconciled from the database: ${error}`);
        }
    }

    /**
     * Trigger an immediate check (on-demand run).
     */
    public check = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const id = z.string().uuid().parse(req.params.id);
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }
            if (!monitor.scheduledTaskUuid) {
                res.status(400).json({ success: false, error: "Monitor has no backing scheduled task" });
                return;
            }

            const taskRows = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(eq(schemas.scheduledTasks.uuid, monitor.scheduledTaskUuid))
                .limit(1);
            if (!taskRows.length) {
                res.status(404).json({ success: false, error: "Backing task not found" });
                return;
            }

            // A paused/inactive monitor would 202 here but the worker silently drops
            // the job at the isPaused re-check — surface the real state instead of a
            // spinner that never completes.
            if (!monitor.isActive || !taskRows[0].isActive || taskRows[0].isPaused) {
                res.status(409).json({
                    success: false,
                    error: "Monitor is paused. Resume it before triggering a check.",
                    code: "MONITOR_PAUSED",
                    pause_reason: taskRows[0].pauseReason,
                });
                return;
            }

            // Dedup guard: reject if a run is already pending/running for this monitor's
            // task. Prevents a client from flooding the queue via repeated /check calls.
            const inFlight = await db
                .select({ uuid: schemas.taskExecutions.uuid })
                .from(schemas.taskExecutions)
                .where(
                    sql`${schemas.taskExecutions.scheduledTaskUuid} = ${monitor.scheduledTaskUuid}
                        AND ${schemas.taskExecutions.status} IN ('pending', 'running')`
                )
                .limit(1);
            if (monitor.inProgress || inFlight.length > 0) {
                res.status(409).json({
                    success: false,
                    error: "A check is already in progress for this monitor",
                    code: "MONITOR_CHECK_IN_PROGRESS",
                });
                return;
            }

            try {
                // Enqueue a one-off run onto the shared Redis "scheduler" queue. The
                // API process does not run the scheduler itself (separate worker
                // image), so gate on an actual queue consumer — NOT the in-process
                // "is running" flag, which is always false here and used to make
                // /check return 503 unconditionally in split deployments. Without a
                // consumer a 202 would be a lie: the job would sit queued forever
                // (and burst-execute when a scheduler finally starts).
                const { SchedulerManager } = await import("@anycrawl/scrape");
                const scheduler = SchedulerManager.getInstance();
                if (!(await scheduler.hasSchedulerConsumer())) {
                    res.status(503).json({ success: false, error: "Scheduler is not running; cannot trigger on-demand check" });
                    return;
                }
                await scheduler.triggerTaskNow(taskRows[0]);
            } catch (error) {
                log.warning(`Failed to trigger monitor check: ${error}`);
                res.status(500).json({ success: false, error: "Failed to trigger check" });
                return;
            }

            res.status(202).json({ success: true, message: "Check triggered", data: { monitor_id: id } });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * List snapshots for a monitor (paginated).
     */
    public snapshots = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const id = z.string().uuid().parse(req.params.id);
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }

            const { limit, offset } = normalizePagination(
                req.query.limit as string | undefined,
                req.query.offset as string | undefined,
                { defaultLimit: 50, maxLimit: 200 }
            );
            const rows = await listSnapshotsByMonitor(db, id!, offset, limit + 1, z.string().optional().parse(req.query.cursor));
            this.sendPage(res, rows, limit, "capturedAt");
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Get a single snapshot with the full content/extracted payload. The
     * snapshots list intentionally omits these heavy columns — this endpoint
     * is the only way to read them.
     */
    public snapshotDetail = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { id, snapshotId } = z.object({ id: z.string().uuid(), snapshotId: z.string().uuid() }).parse(req.params);
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }

            const snapshot = await getSnapshotForMonitor(db, id!, snapshotId!);
            if (!snapshot) {
                res.status(404).json({ success: false, error: "Snapshot not found" });
                return;
            }
            const content = snapshot.content ?? null;
            const contentTruncated = typeof content === "string" && content.length > config.monitor.maxInlineContentChars;
            res.json({ success: true, data: serializeRecord({ ...snapshot,
                content: contentTruncated ? content.slice(0, config.monitor.maxInlineContentChars) : content,
                contentTruncated, contentLength: content?.length ?? 0,
            }) });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * List detected changes for a monitor (paginated). Doubles as price-history source.
     */
    public changes = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const id = z.string().uuid().parse(req.params.id);
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }

            const { limit, offset } = normalizePagination(
                req.query.limit as string | undefined,
                req.query.offset as string | undefined,
                { defaultLimit: 50, maxLimit: 200 }
            );
            const cursor = z.string().optional().parse(req.query.cursor);
            const includeDiffText = z.enum(["true", "false"]).optional().parse(req.query.include_diff_text) !== "false";
            const rows = await listChangesByMonitor(db, id!, offset, limit + 1, { cursor, includeDiffText });
            this.sendPage(res, rows, limit);
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Get a single change record with full diff.
     */
    public changeDetail = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { id, changeId } = z.object({ id: z.string().uuid(), changeId: z.string().uuid() }).parse(req.params);
            const owner = this.getOwnerContext(req);
            const db = await getDB();

            const monitor = await getOwnedMonitor(db, id!, owner);
            if (!monitor) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }

            const rows = await db
                .select()
                .from(schemas.monitorChanges)
                .where(
                    sql`${schemas.monitorChanges.uuid} = ${changeId}
                        AND ${schemas.monitorChanges.monitorUuid} = ${id}`
                )
                .limit(1);
            if (!rows.length) {
                res.status(404).json({ success: false, error: "Change not found" });
                return;
            }
            const notifications = await listMonitorNotificationHistory(db, id, changeId);
            res.json({ success: true, data: serializeRecord({ ...rows[0], notifications: serializeRecords(notifications) }) });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    public checks = async (req: RequestWithAuth, res: Response): Promise<void> => {
        await this.history(req, res, "checks");
    };

    public notifications = async (req: RequestWithAuth, res: Response): Promise<void> => {
        await this.history(req, res, "notifications");
    };

    private async history(req: RequestWithAuth, res: Response, kind: "checks" | "notifications"): Promise<void> {
        try {
            const id = z.string().uuid().parse(req.params.id), db = await getDB();
            if (!await getOwnedMonitor(db, id, this.getOwnerContext(req))) {
                res.status(404).json({ success: false, error: "Monitor not found" });
                return;
            }
            const { limit } = normalizePagination(req.query.limit as string | undefined, undefined, { defaultLimit: 50, maxLimit: 200 });
            const rows = kind === "checks" ? await listMonitorCheckHistory(db, id, limit) : await listMonitorNotificationHistory(db, id, undefined, limit);
            res.json({ success: true, data: serializeRecords(rows) });
        } catch (error) { this.handleError(error, res); }
    }

    private sendPage(res: Response, rows: any[], limit: number, timeField: "createdAt" | "capturedAt" = "createdAt"): void {
        const hasMore = rows.length > limit, page = rows.slice(0, limit);
        res.json({ success: true, data: serializeRecords(page), pagination: {
            has_more: hasMore, next_cursor: hasMore ? encodeMonitorCursor(page[page.length - 1], timeField) : null,
        } });
    }

    /** Check every target's scrape options against the plan. */
    private checkTargets(targets: any[] | undefined, limits: PlanLimits) {
        for (const target of targets ?? []) {
            const violation = checkPlanFeatures(target?.options, limits);
            if (violation) return violation;
        }
        return null;
    }

    private calculateNextExecution(cronExpression: string, timezone: string): Date | null {
        try {
            const interval = CronExpressionParser.parse(cronExpression, {
                tz: timezone || "UTC",
                currentDate: new Date(),
            });
            return interval.next().toDate();
        } catch (error) {
            log.error(`Failed to calculate next execution: ${error}`);
            return null;
        }
    }

    private getOwnerContext(req: RequestWithAuth): OwnerContext {
        return {
            apiKeyId: req.auth?.uuid,
            userId: req.auth?.user,
        };
    }

    private handleError(error: any, res: Response): void {
        if (error instanceof MonitorCursorError) {
            res.status(400).json({ success: false, error: error.message, code: error.code });
        } else if (error instanceof z.ZodError) {
            const formattedErrors = error.errors.map((err) => ({
                field: err.path.join("."),
                message: err.message,
                code: err.code,
            }));
            const message = error.errors.map((err) => err.message).join(", ");
            res.status(400).json({
                success: false,
                error: "Validation error",
                message,
                details: formattedErrors,
            });
        } else {
            log.error(`Monitor controller error: ${error}`);
            res.status(500).json({
                success: false,
                error: "Internal server error",
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
}
