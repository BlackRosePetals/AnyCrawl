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

function wantsStealth(blocks: Record<string, unknown>[]): boolean {
    return blocks.some((b) => b.proxy === "stealth");
}

function wantsAiFormat(blocks: Record<string, unknown>[]): string | null {
    for (const block of blocks) {
        const formats = block.formats;
        if (!Array.isArray(formats)) continue;
        for (const format of ["json", "summary"]) {
            if (formats.includes(format)) return format;
        }
    }
    return null;
}

/**
 * Gate the plan-restricted scrape features (stealth proxy, AI formats).
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
    const blocks = optionBlocks(req.body);

    if (!limits.stealthProxy && wantsStealth(blocks)) {
        res.status(403).json({
            success: false,
            error: "Stealth proxy not available on your plan",
            message: "Upgrade to Hobby or above to use proxy: stealth.",
        });
        return;
    }

    if (!limits.aiFormats) {
        const format = wantsAiFormat(blocks);
        if (format) {
            res.status(403).json({
                success: false,
                error: `The "${format}" format is not available on your plan`,
                message: `Upgrade to Hobby or above to use AI-backed formats.`,
            });
            return;
        }
    }

    next();
};
