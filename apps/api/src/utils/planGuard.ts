import { Response } from "express";
import {
    RequestWithAuth,
    appConfig,
    config,
    getPlanLimits,
    checkPlanFeatures,
    type PlanLimits,
    type PlanViolation,
} from "@anycrawl/libs";

/**
 * The option objects a scrape-shaped request body can put `proxy` into, per the
 * zod schemas:
 *
 * - top level — scrapeSchema, batchScrapeSchema, and crawlSchema when the caller
 *   sends no `scrape_options`
 * - `scrape_options` — crawlSchema and searchSchema
 *
 * Nothing else is reachable: `crawlSchema` is `.strict()`, so a top-level
 * `options` or a nested `scrape_options.scrape_options` is a 400.
 */
function optionBlocks(body: unknown): Record<string, unknown>[] {
    if (!body || typeof body !== "object" || Array.isArray(body)) return [];
    const root = body as Record<string, unknown>;
    const blocks: Record<string, unknown>[] = [root];
    const nested = root.scrape_options;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        blocks.push(nested as Record<string, unknown>);
    }
    return blocks;
}

export function findPlanViolation(body: unknown, limits: PlanLimits): PlanViolation | null {
    for (const block of optionBlocks(body)) {
        const violation = checkPlanFeatures(block, limits);
        if (violation) return violation;
    }
    return null;
}

/**
 * Check a scrape-shaped payload against the caller's plan and send a 403 if it
 * is not allowed.
 *
 * Call this on options that are already RESOLVED — after a template has been
 * merged, not on the raw body. A request carrying only `template_id` has no
 * `proxy` of its own; the stored template supplies it server-side.
 *
 * Returns true when a response has been sent.
 */
export function rejectIfPlanForbids(req: RequestWithAuth, res: Response, payload: unknown): boolean {
    if (!appConfig.authEnabled || !config.auth.planLimitsEnabled) return false;
    const limits = getPlanLimits(req.auth?.subscriptionTier);
    const violation = findPlanViolation(payload, limits);
    if (!violation) return false;
    res.status(403).json({ success: false, error: violation.code, message: violation.message });
    return true;
}
