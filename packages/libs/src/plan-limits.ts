import { CronExpressionParser } from "cron-parser";
import { config } from "./config.js";

export type PlanTier = "free" | "hobby" | "pro" | "business";

export interface PlanLimits {
    /** Max simultaneous in-flight API requests for one key. */
    concurrency: number;
    /** Whether `proxy: stealth` may be requested. */
    stealthProxy: boolean;
    /** Max monitors the owner may keep at once. */
    monitors: number;
    /** Shortest allowed interval between monitor checks, in minutes. */
    minMonitorIntervalMinutes: number;
}

/**
 * What every caller gets when plan limits are switched off — the historical
 * behaviour, and the default for self-hosted deployments.
 */
export const UNLIMITED_PLAN_LIMITS: PlanLimits = Object.freeze({
    concurrency: Number.POSITIVE_INFINITY,
    stealthProxy: true,
    monitors: Number.POSITIVE_INFINITY,
    minMonitorIntervalMinutes: 0,
});

/**
 * `minMonitorIntervalMinutes` is matched to the dashboard's frequency presets:
 * free's 360 is the "every 6 hours" preset, which is also the form's default, so
 * a free user who changes nothing can still create a monitor. Tighter presets are
 * unreachable on free anyway — every 15 minutes is 2,880 checks against a 1,000
 * credit allowance.
 */
const DEFAULT_PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
    free: { concurrency: 2, stealthProxy: false, monitors: 1, minMonitorIntervalMinutes: 360 },
    hobby: { concurrency: 5, stealthProxy: true, monitors: 10, minMonitorIntervalMinutes: 60 },
    pro: { concurrency: 20, stealthProxy: true, monitors: 50, minMonitorIntervalMinutes: 15 },
    business: { concurrency: 50, stealthProxy: true, monitors: 200, minMonitorIntervalMinutes: 15 },
};

const TIERS: PlanTier[] = ["free", "hobby", "pro", "business"];

export function isPlanTier(value: string | null | undefined): value is PlanTier {
    return !!value && (TIERS as string[]).includes(value.toLowerCase());
}

/** A plan rule a request broke. Callers turn this into their own error shape. */
export interface PlanViolation {
    code: "stealth_proxy_not_allowed";
    message: string;
}

/**
 * Check resolved scrape options against a plan.
 *
 * Takes options AFTER templates, monitor targets and scheduled-task payloads
 * have been merged — never a raw request body. Those three paths assemble
 * options server-side, so a body-shape check cannot see what will actually run.
 */
export function checkPlanFeatures(
    options: Record<string, unknown> | null | undefined,
    limits: PlanLimits
): PlanViolation | null {
    if (!options) return null;
    if (!limits.stealthProxy && options.proxy === "stealth") {
        return {
            code: "stealth_proxy_not_allowed",
            message: "Stealth proxy is not available on your plan. Upgrade to Hobby or above to use proxy: stealth.",
        };
    }
    return null;
}

const NUMERIC_FIELDS = ["concurrency", "monitors", "minMonitorIntervalMinutes"] as const;

function validateOverride(tier: string, limits: Record<string, unknown>): void {
    for (const [field, value] of Object.entries(limits)) {
        if (field === "stealthProxy") {
            if (typeof value !== "boolean") {
                throw new Error(`ANYCRAWL_PLAN_LIMITS_JSON: ${tier}.stealthProxy must be a boolean`);
            }
            continue;
        }
        if (!(NUMERIC_FIELDS as readonly string[]).includes(field)) {
            throw new Error(`ANYCRAWL_PLAN_LIMITS_JSON: ${tier} has unknown limit "${field}"`);
        }
        // A string like "2" would pass through and then fail Number.isFinite at the
        // call site, silently turning the limit OFF. Reject it here instead.
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            throw new Error(
                `ANYCRAWL_PLAN_LIMITS_JSON: ${tier}.${field} must be a non-negative finite number, got ${JSON.stringify(value)}`
            );
        }
    }
}

let overridesCache: { raw: string; value: Partial<Record<PlanTier, Partial<PlanLimits>>> } | undefined;

/**
 * Optional per-deployment overrides, e.g.
 * ANYCRAWL_PLAN_LIMITS_JSON='{"pro":{"concurrency":40}}'
 */
function overrides(): Partial<Record<PlanTier, Partial<PlanLimits>>> {
    const raw = process.env.ANYCRAWL_PLAN_LIMITS_JSON;
    if (!raw) return {};
    if (overridesCache?.raw === raw) return overridesCache.value;

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error("ANYCRAWL_PLAN_LIMITS_JSON must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("ANYCRAWL_PLAN_LIMITS_JSON must be a JSON object keyed by plan tier");
    }
    for (const [key, limits] of Object.entries(parsed as Record<string, unknown>)) {
        if (!isPlanTier(key)) {
            throw new Error(`ANYCRAWL_PLAN_LIMITS_JSON has unknown plan tier "${key}"`);
        }
        if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
            throw new Error(`ANYCRAWL_PLAN_LIMITS_JSON: ${key} must be an object of limits`);
        }
        validateOverride(key, limits as Record<string, unknown>);
    }
    const value = parsed as Partial<Record<PlanTier, Partial<PlanLimits>>>;
    overridesCache = { raw, value };
    return value;
}

/**
 * Parse the override env var once at boot so a typo fails the process instead of
 * throwing from inside a middleware on every request.
 */
export function validatePlanLimitsConfig(): void {
    overrides();
}

/**
 * Resolve the limits for a tier. Returns UNLIMITED_PLAN_LIMITS whenever plan
 * limits are disabled, so self-hosted installs never hit a cap.
 */
export function getPlanLimits(tier: string | null | undefined): PlanLimits {
    if (!config.auth.planLimitsEnabled) return UNLIMITED_PLAN_LIMITS;
    const resolved: PlanTier = isPlanTier(tier) ? (tier.toLowerCase() as PlanTier) : "free";
    return { ...DEFAULT_PLAN_LIMITS[resolved], ...overrides()[resolved] };
}

/**
 * Shortest gap, in minutes, between consecutive runs of a cron expression, or
 * null if it cannot be parsed.
 *
 * Always evaluated in UTC, deliberately. A plan floor is about the nominal
 * cadence the user asked for, and a wall-clock schedule in a DST timezone
 * compresses one gap by an hour twice a year: a six-hourly schedule in Sydney
 * yields a 300-minute gap on the spring-forward day. Judging that as "faster
 * than your plan allows" would 403 the dashboard's own default preset for a
 * week every year.
 *
 * Sampled over several runs because a step expression is uneven across a day,
 * and the floor must be compared against the tightest gap. Twelve samples cover
 * every dashboard preset: the shortest cycle is 15 minutes, where 13 samples
 * span 3 hours, and the longest is weekly, which needs one.
 */
export function cronIntervalMinutes(cronExpression: string): number | null {
    try {
        const interval = CronExpressionParser.parse(cronExpression, {
            tz: "UTC",
            currentDate: new Date(),
        });
        let previous = interval.next().toDate().getTime();
        let smallest = Number.POSITIVE_INFINITY;
        for (let i = 0; i < 12; i++) {
            const nextRun = interval.next().toDate().getTime();
            smallest = Math.min(smallest, (nextRun - previous) / 60_000);
            previous = nextRun;
        }
        return Number.isFinite(smallest) ? smallest : null;
    } catch {
        return null;
    }
}
