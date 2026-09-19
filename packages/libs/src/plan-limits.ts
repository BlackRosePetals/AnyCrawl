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
    /** How long job results and monitor snapshots are kept. */
    retentionDays: number;
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
    retentionDays: Number.POSITIVE_INFINITY,
});

const DEFAULT_PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
    free: { concurrency: 2, stealthProxy: false, monitors: 1, minMonitorIntervalMinutes: 1440, retentionDays: 7 },
    hobby: { concurrency: 5, stealthProxy: true, monitors: 10, minMonitorIntervalMinutes: 60, retentionDays: 30 },
    pro: { concurrency: 20, stealthProxy: true, monitors: 50, minMonitorIntervalMinutes: 15, retentionDays: 90 },
    business: { concurrency: 50, stealthProxy: true, monitors: 200, minMonitorIntervalMinutes: 15, retentionDays: 365 },
};

const TIERS: PlanTier[] = ["free", "hobby", "pro", "business"];

export function isPlanTier(value: string | null | undefined): value is PlanTier {
    return !!value && (TIERS as string[]).includes(value);
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
    for (const key of Object.keys(parsed as object)) {
        if (!isPlanTier(key)) {
            throw new Error(`ANYCRAWL_PLAN_LIMITS_JSON has unknown plan tier "${key}"`);
        }
    }
    const value = parsed as Partial<Record<PlanTier, Partial<PlanLimits>>>;
    overridesCache = { raw, value };
    return value;
}

/**
 * Resolve the limits for a tier. Returns UNLIMITED_PLAN_LIMITS whenever plan
 * limits are disabled, so self-hosted installs never hit a cap.
 */
export function getPlanLimits(tier: string | null | undefined): PlanLimits {
    if (!config.auth.planLimitsEnabled) return UNLIMITED_PLAN_LIMITS;
    const resolved: PlanTier = isPlanTier(tier) ? tier : "free";
    return { ...DEFAULT_PLAN_LIMITS[resolved], ...overrides()[resolved] };
}
