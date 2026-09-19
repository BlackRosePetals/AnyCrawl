import { Response, NextFunction } from "express";
import { RequestWithAuth } from "@anycrawl/libs";
import { rejectIfPlanForbids } from "../utils/planGuard.js";

/**
 * Gate plan-restricted scrape features on the direct scrape/crawl/search/batch
 * routes, where the request body IS the effective configuration.
 *
 * This cannot cover the paths that assemble options server-side — templates,
 * monitor targets and scheduled-task payloads. Those check at their own write or
 * merge points, also via `rejectIfPlanForbids`.
 *
 * A no-op unless auth AND plan limits are both enabled, so self-hosted installs
 * keep every feature.
 */
export const planFeatureMiddleware = (
    req: RequestWithAuth,
    res: Response,
    next: NextFunction
): void => {
    if (rejectIfPlanForbids(req, res, req.body)) return;
    next();
};
