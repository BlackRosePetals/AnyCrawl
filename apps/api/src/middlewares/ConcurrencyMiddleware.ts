import { Response, NextFunction } from "express";
import { RequestWithAuth, appConfig, config, getPlanLimits } from "@anycrawl/libs";
import { log } from "@anycrawl/libs/log";
import { Utils } from "@anycrawl/scrape";

/**
 * How long a held slot survives without being released. A worker that dies
 * mid-request would otherwise leak a slot forever; the TTL is refreshed on
 * every acquire, so it only expires once a key goes fully idle.
 */
const SLOT_TTL_SECONDS = Number(process.env.ANYCRAWL_CONCURRENCY_SLOT_TTL_SECS ?? 300);

/** DECR that never drifts below zero if the counter expired under us. */
const RELEASE_SCRIPT = `
local current = redis.call('DECR', KEYS[1])
if current < 0 then
  redis.call('SET', KEYS[1], 0)
  return 0
end
return current
`;

const slotKey = (apiKeyId: string) => `anycrawl:concurrency:${apiKeyId}`;

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
    let redis;
    let held = 0;
    try {
        redis = Utils.getInstance().getRedisConnection();
        held = await redis.incr(key);
        await redis.expire(key, SLOT_TTL_SECONDS);
    } catch (error) {
        log.error(`[Concurrency] failed to acquire slot, allowing request: ${error}`);
        next();
        return;
    }

    if (held > limit) {
        try {
            await redis.eval(RELEASE_SCRIPT, 1, key);
        } catch (error) {
            log.error(`[Concurrency] failed to release rejected slot: ${error}`);
        }
        res.status(429).json({
            success: false,
            error: "Concurrency limit reached",
            message: `Your plan allows ${limit} concurrent request${limit === 1 ? "" : "s"}. Retry when an in-flight request finishes, or upgrade your plan.`,
            limit,
        });
        return;
    }

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

    next();
};
