import type { OwnerContext } from "@anycrawl/libs";
import { eq, and, ne, lt, or, desc, sql, getTableColumns } from "drizzle-orm";
import { schemas } from "../db/index.js";

type DBExecutor = any;

function ownerCondition(owner: OwnerContext) {
    return owner.userId ? eq(schemas.monitors.userId, owner.userId)
        : owner.apiKeyId ? eq(schemas.monitors.apiKey, owner.apiKeyId) : undefined;
}

function monitorSelection() {
    return {
        ...getTableColumns(schemas.monitors),
        cronExpression: schemas.scheduledTasks.cronExpression,
        timezone: schemas.scheduledTasks.timezone,
        nextExecutionAt: schemas.scheduledTasks.nextExecutionAt,
        lastExecutionAt: schemas.scheduledTasks.lastExecutionAt,
        isPaused: schemas.scheduledTasks.isPaused,
        pauseReason: schemas.scheduledTasks.pauseReason,
        tags: schemas.scheduledTasks.tags,
        metadata: schemas.scheduledTasks.metadata,
        inProgress: sql`EXISTS (SELECT 1 FROM ${schemas.monitorChecks} WHERE ${schemas.monitorChecks.monitorUuid} = ${schemas.monitors.uuid} AND ${schemas.monitorChecks.state} IN ('pending', 'ready', 'processing'))`.mapWith(Boolean),
        lastCheckState: sql`(SELECT ${schemas.monitorChecks.state} FROM ${schemas.monitorChecks} WHERE ${schemas.monitorChecks.monitorUuid} = ${schemas.monitors.uuid} ORDER BY ${schemas.monitorChecks.sequenceNumber} DESC LIMIT 1)`,
        lastCheckError: sql`(SELECT ${schemas.monitorChecks.lastError} FROM ${schemas.monitorChecks} WHERE ${schemas.monitorChecks.monitorUuid} = ${schemas.monitors.uuid} ORDER BY ${schemas.monitorChecks.sequenceNumber} DESC LIMIT 1)`,
        lastCheckAt: sql`(SELECT ${schemas.monitorChecks.processedAt} FROM ${schemas.monitorChecks} WHERE ${schemas.monitorChecks.monitorUuid} = ${schemas.monitors.uuid} ORDER BY ${schemas.monitorChecks.sequenceNumber} DESC LIMIT 1)`.mapWith(schemas.monitorChecks.processedAt),
    };
}

function publicMonitor(row: any): any {
    if (!row) return null;
    const { monitorManaged: _managed, monitorUuid: _uuid, ...metadata } = row.metadata ?? {};
    return { ...row, metadata: Object.keys(metadata).length ? metadata : null,
        capabilities: { location: false, ignore_selectors: "text_lines", targets_per_check: 1 } };
}

export function buildMonitorWhereClause(monitorId: string, owner: OwnerContext): any {
    return and(eq(schemas.monitors.uuid, monitorId), ownerCondition(owner));
}

export async function getOwnedMonitor(db: DBExecutor, monitorId: string, owner: OwnerContext): Promise<any | null> {
    const rows = await db.select(monitorSelection()).from(schemas.monitors)
        .leftJoin(schemas.scheduledTasks, eq(schemas.monitors.scheduledTaskUuid, schemas.scheduledTasks.uuid))
        .where(buildMonitorWhereClause(monitorId, owner)).limit(1);
    return publicMonitor(rows[0]);
}

export async function listMonitorsByOwner(db: DBExecutor, owner: OwnerContext): Promise<any[]> {
    const rows = await db.select(monitorSelection()).from(schemas.monitors)
        .leftJoin(schemas.scheduledTasks, eq(schemas.monitors.scheduledTaskUuid, schemas.scheduledTasks.uuid))
        .where(ownerCondition(owner)).orderBy(desc(schemas.monitors.createdAt), desc(schemas.monitors.uuid));
    return rows.map(publicMonitor);
}

/** Count an owner's monitors. Used by the plan gate, which only needs the number. */
export async function countMonitorsByOwner(db: DBExecutor, owner: OwnerContext): Promise<number> {
    const rows = await db.select({ count: sql<number>`count(*)` }).from(schemas.monitors)
        .where(ownerCondition(owner));
    return Number(rows[0]?.count ?? 0);
}

export async function getMonitorByScheduledTask(db: DBExecutor, scheduledTaskUuid: string): Promise<any | null> {
    const rows = await db.select().from(schemas.monitors).where(eq(schemas.monitors.scheduledTaskUuid, scheduledTaskUuid)).limit(1);
    return rows[0] ?? null;
}

/** Only complete content under the captured configuration revision is a baseline. */
export async function getLatestSnapshot(db: DBExecutor, monitorUuid: string, url: string, revision?: number): Promise<any | null> {
    const rows = await db.select().from(schemas.monitorSnapshots).where(and(
        eq(schemas.monitorSnapshots.monitorUuid, monitorUuid), eq(schemas.monitorSnapshots.url, url), ne(schemas.monitorSnapshots.status, "error"),
        ...(revision === undefined ? [] : [eq(schemas.monitorSnapshots.monitorRevision, revision), eq(schemas.monitorSnapshots.contentComplete, true)]),
    )).orderBy(desc(schemas.monitorSnapshots.sequenceNumber), desc(schemas.monitorSnapshots.capturedAt), desc(schemas.monitorSnapshots.uuid)).limit(1);
    return rows[0] ?? null;
}

export class MonitorCursorError extends Error {
    readonly code = "INVALID_MONITOR_CURSOR";
    constructor() { super("Invalid monitor pagination cursor"); }
}

export function encodeMonitorCursor(row: any, timeField: "createdAt" | "capturedAt" = "createdAt"): string {
    return Buffer.from(JSON.stringify({ time: new Date(row[timeField]).toISOString(), uuid: row.uuid })).toString("base64url");
}

function cursorCondition(cursor: string | undefined, time: any, uuid: any): any {
    if (cursor === undefined) return undefined;
    try {
        if (typeof cursor !== "string" || !cursor || cursor.length > 512) throw new Error();
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        const date = new Date(decoded.time);
        if (date.toISOString() !== decoded.time || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.uuid)) throw new Error();
        return or(lt(time, date), and(eq(time, date), lt(uuid, decoded.uuid)));
    } catch { throw new MonitorCursorError(); }
}

export async function listSnapshotsByMonitor(db: DBExecutor, monitorUuid: string, skip: number, limit: number, cursor?: string): Promise<any[]> {
    return db.select({
        uuid: schemas.monitorSnapshots.uuid, monitorUuid: schemas.monitorSnapshots.monitorUuid,
        taskExecutionUuid: schemas.monitorSnapshots.taskExecutionUuid, checkUuid: schemas.monitorSnapshots.checkUuid,
        monitorRevision: schemas.monitorSnapshots.monitorRevision, sequenceNumber: schemas.monitorSnapshots.sequenceNumber,
        url: schemas.monitorSnapshots.url, contentHash: schemas.monitorSnapshots.contentHash,
        contentComplete: schemas.monitorSnapshots.contentComplete, status: schemas.monitorSnapshots.status, capturedAt: schemas.monitorSnapshots.capturedAt,
    }).from(schemas.monitorSnapshots).where(and(eq(schemas.monitorSnapshots.monitorUuid, monitorUuid),
        cursorCondition(cursor, schemas.monitorSnapshots.capturedAt, schemas.monitorSnapshots.uuid)))
        .orderBy(desc(schemas.monitorSnapshots.capturedAt), desc(schemas.monitorSnapshots.uuid)).limit(limit).offset(cursor ? 0 : skip);
}

export async function getSnapshotForMonitor(db: DBExecutor, monitorUuid: string, snapshotUuid: string): Promise<any | null> {
    const rows = await db.select().from(schemas.monitorSnapshots).where(and(
        eq(schemas.monitorSnapshots.uuid, snapshotUuid), eq(schemas.monitorSnapshots.monitorUuid, monitorUuid),
    )).limit(1);
    return rows[0] ?? null;
}

export async function listChangesByMonitor(db: DBExecutor, monitorUuid: string, skip: number, limit: number,
    options: { cursor?: string; includeDiffText?: boolean } = {}): Promise<any[]> {
    const selection: any = { ...getTableColumns(schemas.monitorChanges) };
    if (options.includeDiffText === false) delete selection.diffText;
    return db.select(selection).from(schemas.monitorChanges).where(and(eq(schemas.monitorChanges.monitorUuid, monitorUuid),
        cursorCondition(options.cursor, schemas.monitorChanges.createdAt, schemas.monitorChanges.uuid)))
        .orderBy(desc(schemas.monitorChanges.createdAt), desc(schemas.monitorChanges.uuid)).limit(limit).offset(options.cursor ? 0 : skip);
}

/** Owner scope is applied before pagination; feed rows omit heavy diff data. */
export async function listChangesByOwner(db: DBExecutor, owner: OwnerContext, skip: number, limit: number,
    filters: { changeType?: string; cursor?: string } = {}): Promise<any[]> {
    return db.select({
        uuid: schemas.monitorChanges.uuid, monitorUuid: schemas.monitorChanges.monitorUuid,
        monitorName: schemas.monitors.name, monitorType: schemas.monitors.monitorType,
        url: schemas.monitorChanges.url, changeType: schemas.monitorChanges.changeType,
        judgment: schemas.monitorChanges.judgment, notified: schemas.monitorChanges.notified,
        notificationStatus: schemas.monitorChanges.notificationStatus, createdAt: schemas.monitorChanges.createdAt,
    }).from(schemas.monitorChanges).innerJoin(schemas.monitors, eq(schemas.monitorChanges.monitorUuid, schemas.monitors.uuid))
        .where(and(ownerCondition(owner), filters.changeType ? eq(schemas.monitorChanges.changeType, filters.changeType) : undefined,
            cursorCondition(filters.cursor, schemas.monitorChanges.createdAt, schemas.monitorChanges.uuid)))
        .orderBy(desc(schemas.monitorChanges.createdAt), desc(schemas.monitorChanges.uuid)).limit(limit).offset(filters.cursor ? 0 : skip);
}
