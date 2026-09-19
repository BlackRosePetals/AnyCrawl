import { Response, NextFunction } from "express";
import { RequestWithAuth, appConfig, config, getPlanLimits } from "@anycrawl/libs";
import { log } from "@anycrawl/libs/log";
import { Utils } from "@anycrawl/scrape";

/**
 * A held slot must outlive the longest request a caller can ask for, or the key
 * expires mid-request and the eventual release decrements someone else's slot.
 * BaseSchema caps `timeout` at 600s; the margin covers queue and response time.
 */
const SLOT_TTL_SECONDS = Number(process.env.ANYCRAWL_CONCURRENCY_SLOT_TTL_SECS ?? 660);

/**
 * DECR that never drifts below zero, and — unlike a bare SET — keeps the TTL so
 * a clamped key still expires instead of lingering at zero forever.
 */
const RELEASE_SCRIPT = `
local current = redis.call('DECR', KEYS[1])
if current < 0 then
  redis.call('SET', KEYS[1], 0, 'KEEPTTL')
  return 0
end
return current
`;

const slotKey = (apiKeyId: string) => `anycrawl:concurrency:${apiKeyId}`;

/**
 * A connection of our own, NOT the shared BullMQ one.
 *
 * The shared connection uses `maxRetriesPerRequest: null`, which BullMQ requires
 * but which makes ioredis queue commands until it reconnects rather than
 * rejecting them. On that connection an outage would hang every gated request
 * forever instead of failing fast — the opposite of what a limiter should do.
 */
let redisClient: ReturnType<typeof Utils.prototype.createFailFastRedisConnection> | undefined;

function getRedis() {
    if (!redisClient) {
        redisClient = Utils.getInstance().createFailFastRedisConnection();
    }
    return redisClient;
}

/**
 * Per-plan concurrency gate.
 *
 * Attach as ROUTE-LEVEL middleware on routes that start real work, alongside
 * `checkCreditsMiddleware`.
 *
 * Disabled unless BOTH auth and plan limits are on, so a self-hosted install
 * (which sets neither) is never throttled. On any Redis failure the request is
 * allowed through: a limiter must not be able to take the API down.
 */
export const concurrencyMiddleware = async (
    req: RequestWithAuth,
    res: Response,
    next: NextFunction
): Promise<void> => {
    if (!appConfig.authEnabled || !config.auth.planLimitsEnabled) {
        next();
        return;
    }

    const apiKeyId = req.auth?.uuid;
    const limit = getPlanLimits(req.auth?.subscriptionTier).concurrency;
    if (!apiKeyId || !Number.isFinite(limit)) {
        next();
        return;
    }

    const key = slotKey(apiKeyId);
    const redis = getRedis();

    let held: number;
    try {
        held = await redis.incr(key);
    } catch (error) {
        log.error(`[Concurrency] failed to acquire slot, allowing request: ${error}`);
        next();
        return;
    }

    // Register the release BEFORE anything else that can throw. Previously the
    // TTL call sat between acquire and release-registration, so a failure there
    // leaked the slot permanently.
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        redis.eval(RELEASE_SCRIPT, 1, key).catch((error: unknown) => {
            log.error(`[Concurrency] failed to release slot: ${error}`);
        });
    };
    // 'close' covers client disconnects that never reach 'finish'.
    res.once("finish", release);
    res.once("close", release);

    if (held > limit) {
        // Release without touching the TTL. Refreshing it here would let a client
        // that keeps retrying hold its own key alive forever, so a counter left
        // high by a crash could never decay and the key would be locked out.
        release();
        res.status(429).json({
            success: false,
            error: "Concurrency limit reached",
            message: `Your plan allows ${limit} concurrent request${limit === 1 ? "" : "s"}. Retry when an in-flight request finishes, or upgrade your plan.`,
            limit,
        });
        return;
    }

    try {
        await redis.expire(key, SLOT_TTL_SECONDS);
    } catch (error) {
        // The slot is held and will still be released on response; only the crash
        // backstop is missing, so log and continue rather than failing the request.
        log.error(`[Concurrency] failed to set slot TTL: ${error}`);
    }

    next();
};
