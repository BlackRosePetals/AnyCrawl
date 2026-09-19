import { Response, NextFunction } from "express";
import { RequestWithAuth, appConfig, config, getPlanLimits } from "@anycrawl/libs";

/**
 * Collect every nested object that can carry scrape options. Scrape/map put them
 * at the top level; crawl and batch scrape nest them under `scrape_options` or
 * `options`, and crawl accepts both shapes.
 */
function optionBlocks(body: unknown): Record<string, unknown>[] {
    if (!body || typeof body !== "object") return [];
    const root = body as Record<string, unknown>;
    const blocks = [root];
    for (const key of ["scrape_options", "options"]) {
        const nested = root[key];
        if (nested && typeof nested === "object" && !Array.isArray(nested)) {
            blocks.push(nested as Record<string, unknown>);
            const deeper = (nested as Record<string, unknown>).scrape_options;
            if (deeper && typeof deeper === "object" && !Array.isArray(deeper)) {
                blocks.push(deeper as Record<string, unknown>);
            }
        }
    }
    return blocks;
}

/**
 * Gate the plan-restricted scrape features.
 *
 * Only the stealth proxy is gated: it costs residential bandwidth per request.
 * The AI-backed formats (`json`, `summary`) stay available on every tier.
 *
 * Like the concurrency gate, this is a no-op unless auth AND plan limits are
 * both enabled, so self-hosted installs keep every feature.
 */
export const planFeatureMiddleware = (
    req: RequestWithAuth,
    res: Response,
    next: NextFunction
): void => {
    if (!appConfig.authEnabled || !config.auth.planLimitsEnabled) {
        next();
        return;
    }

    const limits = getPlanLimits(req.auth?.subscriptionTier);
    if (!limits.stealthProxy && optionBlocks(req.body).some((b) => b.proxy === "stealth")) {
        res.status(403).json({
            success: false,
            error: "Stealth proxy not available on your plan",
            message: "Upgrade to Hobby or above to use proxy: stealth.",
        });
        return;
    }

    next();
};
