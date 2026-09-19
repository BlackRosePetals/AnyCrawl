import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { RequestWithAuth, checkPlanFeatures, getPlanLimits } from "@anycrawl/libs";
import { rejectIfPlanForbids, findPlanViolation } from "../utils/planGuard.js";

const original = process.env;

beforeEach(() => {
    process.env = {
        ...original,
        ANYCRAWL_API_AUTH_ENABLED: "true",
        ANYCRAWL_API_CREDITS_ENABLED: "true",
        ANYCRAWL_API_PLAN_LIMITS_ENABLED: "true",
    };
});
afterEach(() => { process.env = original; });

function mockReq(tier: string): RequestWithAuth {
    return { auth: { subscriptionTier: tier, uuid: "key-1" } } as unknown as RequestWithAuth;
}

function mockRes() {
    const sent: { status?: number; body?: any } = {};
    const res: any = {
        status(code: number) { sent.status = code; return res; },
        json(body: any) { sent.body = body; return res; },
    };
    return { res, sent };
}

describe("stealth proxy is rejected wherever a free caller can put it", () => {
    // scrapeSchema and batchScrapeSchema carry proxy at the top level.
    it("blocks a top-level proxy", () => {
        const { res, sent } = mockRes();
        expect(rejectIfPlanForbids(mockReq("free"), res, { url: "https://x.dev", proxy: "stealth" })).toBe(true);
        expect(sent.status).toBe(403);
        expect(sent.body.error).toBe("stealth_proxy_not_allowed");
    });

    // crawlSchema and searchSchema nest it under scrape_options.
    it("blocks a nested scrape_options.proxy", () => {
        const { res, sent } = mockRes();
        expect(rejectIfPlanForbids(mockReq("free"), res, {
            url: "https://x.dev",
            scrape_options: { proxy: "stealth" },
        })).toBe(true);
        expect(sent.status).toBe(403);
    });

    it.each(["hobby", "pro", "business"])("lets %s through", tier => {
        const { res, sent } = mockRes();
        expect(rejectIfPlanForbids(mockReq(tier), res, { proxy: "stealth" })).toBe(false);
        expect(sent.status).toBeUndefined();
    });

    it.each([{ proxy: "auto" }, { proxy: "base" }, { url: "https://x.dev" }, {}])
        ("lets free through for %p", body => {
            const { res } = mockRes();
            expect(rejectIfPlanForbids(mockReq("free"), res, body)).toBe(false);
        });
});

describe("the guard is inert when the switches are off", () => {
    it.each([
        ["auth off", { ANYCRAWL_API_AUTH_ENABLED: "false", ANYCRAWL_API_PLAN_LIMITS_ENABLED: "true" }],
        ["plan limits off", { ANYCRAWL_API_AUTH_ENABLED: "true", ANYCRAWL_API_PLAN_LIMITS_ENABLED: "false" }],
        ["both off — the self-hosted default", {}],
    ])("allows stealth on free with %s", (_label, env) => {
        process.env = { ...original, ...env };
        delete (process.env as any).ANYCRAWL_API_PLAN_LIMITS_ENABLED;
        Object.assign(process.env, env);
        const { res } = mockRes();
        expect(rejectIfPlanForbids(mockReq("free"), res, { proxy: "stealth" })).toBe(false);
    });
});

describe("shapes the schemas cannot produce are not scanned", () => {
    // crawlSchema is .strict(), so a top-level `options` is a 400 before it ever
    // reaches a gate. Scanning it would only create false positives.
    it("ignores a top-level options object", () => {
        expect(findPlanViolation({ options: { proxy: "stealth" } }, getPlanLimits("free"))).toBeNull();
    });

    it.each([null, undefined, "string", 42, []])("tolerates a %p body", body => {
        expect(findPlanViolation(body, getPlanLimits("free"))).toBeNull();
    });
});

/**
 * Regression for the hole this guard was written to close: monitor targets,
 * scheduled-task payloads and template reqOptions are assembled server-side, so
 * a request-body check never sees the proxy that will actually run. These are
 * the exact option objects those three paths hand to checkPlanFeatures.
 */
describe("server-assembled option blocks are checked at their own write points", () => {
    it("rejects a monitor target's options", () => {
        const target = { url: "https://x.dev", options: { proxy: "stealth" } };
        expect(checkPlanFeatures(target.options, getPlanLimits("free")))
            .toMatchObject({ code: "stealth_proxy_not_allowed" });
    });

    it("rejects a scheduled task payload", () => {
        const taskPayload = { url: "https://x.dev", proxy: "stealth" };
        expect(checkPlanFeatures(taskPayload, getPlanLimits("free")))
            .toMatchObject({ code: "stealth_proxy_not_allowed" });
    });

    it("rejects merged template options even though the request body had no proxy", () => {
        const requestBody = { template_id: "tpl_1", url: "https://x.dev" };
        expect(findPlanViolation(requestBody, getPlanLimits("free"))).toBeNull();
        const merged = { ...requestBody, proxy: "stealth" };
        expect(findPlanViolation(merged, getPlanLimits("free")))
            .toMatchObject({ code: "stealth_proxy_not_allowed" });
    });
});
