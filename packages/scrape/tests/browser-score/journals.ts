import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { identifier, redactText } from "./config.js";

// Explicit application-engine integration test. No API server, production DB or scheduler.
const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
    "repository": { type: "string", default: path.resolve(here, "../../../..") },
    "baseline-source": { type: "string" },
    "targets": { type: "string" },
    "rounds": { type: "string", default: "1" },
    "profile": { type: "string", default: "application" },
    "timeout-ms": { type: "string", default: "45000" },
    "proxy-env": { type: "string", default: "ANYCRAWL_PROXY_URL" },
    "proxy-index": { type: "string", default: "0" },
} });
const repository = path.resolve(values.repository!);
const profile = values.profile!;
if (!["application", "full-resources", "existing-solver"].includes(profile)) throw new Error("Invalid profile");
if (profile === "existing-solver" && !process.env.ANYCRAWL_2CAPTCHA_API_KEY?.trim())
    throw new Error("existing-solver requires the configured ANYCRAWL_2CAPTCHA_API_KEY");
if (profile !== "application" && values["baseline-source"]) throw new Error("Run optional profiles separately from the staged baseline comparison");
const rounds = Number(values.rounds);
const timeoutMs = Number(values["timeout-ms"]);
const index = Number(values["proxy-index"]);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000 || !Number.isInteger(index) || index < 0)
    throw new Error("Invalid rounds, timeout-ms or proxy-index");
const proxy = (process.env[values["proxy-env"]!] ?? "").split(",").map((s) => s.trim()).filter(Boolean)[index];
if (!proxy) throw new Error("Configured proxy missing; journal tests do not switch to direct mode");
new URL(proxy);
const redact = (value: string) => redactText(value, proxy, [process.env.CLOAKBROWSER_LICENSE_KEY ?? ""]);
for (const method of ["log", "warn", "error"] as const) {
    const original = console[method].bind(console);
    console[method] = (...values: unknown[]) => original(...values.map((value) => redact(value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value))));
}
const directory = path.join(repository, "output/playwright/journal-access", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
await fs.mkdir(directory, { recursive: true });
Object.assign(process.env, {
    ANYCRAWL_API_DB_TYPE: "sqlite", ANYCRAWL_API_DB_CONNECTION: ":memory:",
    ANYCRAWL_STORAGE: "local", ANYCRAWL_CACHE_ENABLED: "false",
    CRAWLEE_STORAGE_DIR: path.join(directory, "crawlee"), CLOAKBROWSER_AUTO_UPDATE: "false",
});
const { log } = await import("@anycrawl/libs");
log.setLevel(0);
const cloak = await import("cloakbrowser");
const binary = cloak.binaryInfo(process.env.CLOAKBROWSER_VERSION);
const binaryPath = process.env.CLOAKBROWSER_BINARY_PATH || binary.binaryPath;
await fs.access(binaryPath);
process.env.CLOAKBROWSER_BINARY_PATH = binaryPath;
const { RequestQueueV2, ProxyConfiguration } = await import("crawlee");
const targets = JSON.parse(await fs.readFile(values.targets ?? path.join(repository, "packages/scrape/tests/browser-score/journal-targets.json"), "utf8")) as Array<{ id: string; url: string; title: string; bodySelector: string; minimumBodyCharacters: number }>;
const implementations = [
    ...(values["baseline-source"] ? [{ label: "staged-baseline", source: path.resolve(values["baseline-source"]) }] : []),
    { label: "current", source: path.join(repository, "packages/scrape/dist/engines/EngineFactory.js") },
];
const records: Array<Record<string, any>> = [];
const report = { schemaVersion: 1, type: "journal-access", metadata: {
    startedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
    proxyId: identifier(proxy), binary: { path: binaryPath, version: binary.version },
    mode: "Playwright through AnyCrawl EngineFactory, including production hooks/extraction; API, scheduler and durable storage excluded",
    headless: process.env.ANYCRAWL_HEADLESS !== "false", rounds, timeoutMs,
    execution: "node with tsc-built application and runner (no tsx transformation)",
    profile, maxRetriesPerAttempt: 0, contextMode: "isolated", implementations, targets,
}, records };
const save = () => fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, (_key, value) => typeof value === "string" ? redact(value) : value, 2));
let pair = 0;
for (let round = 1; round <= rounds; round++) for (const target of targets) {
    const order = pair++ % 2 === 0 ? implementations : [...implementations].reverse();
    for (const implementation of order) {
        const stem = `r${round}-${target.id}-${implementation.label}`;
        const row: Record<string, any> = { round, target: target.id, url: target.url, implementation: implementation.label,
            success: false, status: "not_completed", mainResponses: [], failedRequests: [], pageErrors: [], consoleErrors: [], artifacts: {} };
        records.push(row);
        const started = Date.now();
        const queue = await RequestQueueV2.open(`journal-${randomUUID()}`);
        let engine: any;
        let page: any;
        const capture = async (context: any, error?: Error) => {
            page = context.page ?? page;
            row.challenge = context.request.userData._anycrawlChallengeState;
            row.retryCount = context.request.retryCount;
            if (error) { row.status = "engine_error"; row.error = redact(error.message); }
            if (!page || page.isClosed()) return;
            try {
                const observed = await page.evaluate((selector: string) => ({
                    title: document.title, heading: Array.from(document.querySelectorAll("h1")).map((e) => (e as HTMLElement).innerText).join(" "),
                    text: document.body?.innerText || "",
                    article: Array.from(document.querySelectorAll(selector)).map((e) => (e as HTMLElement).innerText || "").sort((a, b) => b.length - a.length)[0] || "",
                    finalUrl: location.href,
                    runtime: {
                        turnstileType: typeof (window as any).turnstile,
                        cfOptionKeys: Object.keys((window as any)._cf_chl_opt || (window as any).__cf_chl_opt || {}),
                        capturedParamKeys: Object.keys((window as any).__anycrawlTurnstileParams || {}),
                        widgetElements: document.querySelectorAll('.cf-turnstile, input[name="cf-turnstile-response"]').length,
                        iframeElements: document.querySelectorAll('iframe').length,
                    },
                }), target.bodySelector);
                row.runtime = observed.runtime;
                row.contentElapsedMs = Date.now() - started;
                const artifactStartedAt = Date.now();
                row.title = observed.title; row.heading = observed.heading; row.finalUrl = observed.finalUrl;
                row.bodyCharacters = observed.article.length;
                const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
                row.titleMatched = normalize(observed.heading).includes(normalize(target.title));
                const last = row.mainResponses.at(-1);
                row.httpStatus = last?.status;
                row.success = !error && row.titleMatched && observed.article.length >= target.minimumBodyCharacters
                    && last?.status >= 200 && last.status < 400 && last.challenge !== "challenge";
                if (!error) row.status = row.success ? "article_verified" : "content_assertion_failed";
                await fs.writeFile(path.join(directory, `${stem}.txt`), redact(observed.text));
                await fs.writeFile(path.join(directory, `${stem}.html`), redact(await page.content()));
                row.artifacts.text = `${stem}.txt`; row.artifacts.html = `${stem}.html`;
                await page.screenshot({ path: path.join(directory, `${stem}.png`), fullPage: false, timeout: 10000 });
                row.artifacts.screenshot = `${stem}.png`;
                row.artifactElapsedMs = Date.now() - artifactStartedAt;
            } catch (captureError) { row.captureError = redact(String(captureError)); }
        };
        try {
            await queue.addRequest({ url: target.url, uniqueKey: randomUUID(), maxRetries: 0,
                userData: { jobId: stem, parentId: stem, queueName: "journal-access", engine: "playwright", type: "temporary_scrape",
                    options: { formats: ["markdown"], timeout: timeoutMs, max_age: 0, store_in_cache: false, proxy: profile === "existing-solver" ? "stealth" : "base", humanize: profile === "existing-solver" ? "on" : "auto" } } });
            const { EngineFactoryRegistry } = await import(pathToFileURL(implementation.source).href);
            engine = await EngineFactoryRegistry.createEngine("playwright", queue, {
                proxyConfiguration: new ProxyConfiguration({ proxyUrls: [proxy] }), useSessionPool: false,
                minConcurrency: 1, maxConcurrency: 1, maxSessionRotations: 0, maxRequestsPerCrawl: 1,
                requestHandlerTimeoutSecs: Math.ceil(timeoutMs / 1000) + 15, keepAlive: false,
                launchContext: { launchOptions: { args: [`--fingerprint=${42069 + round - 1}`] } },
                preNavigationHooks: [async (context: any) => {
                    page = context.page;
                    page.on("pageerror", (error: Error) => { if (row.pageErrors.length < 20) row.pageErrors.push(redact(error.message)); });
                    page.on("console", (message: any) => {
                        if (message.type() === "error" && row.consoleErrors.length < 20) row.consoleErrors.push(redact(message.text()).slice(0, 1000));
                    });
                    if (profile !== "application") {
                        const cdp = page.__anycrawlCdpSession;
                        if (!cdp) throw new Error("Application resource-blocking CDP session unavailable");
                        await cdp.send("Fetch.disable");
                        await cdp.send("Network.setBlockedURLs", { urls: [] });
                    }
                    page.on("response", (response: any) => {
                        try {
                            const req = response.request();
                            if (req.isNavigationRequest() && req.frame() === page.mainFrame())
                                row.mainResponses.push({ url: response.url(), status: response.status(), challenge: response.headers()["cf-mitigated"], elapsedMs: Date.now() - started });
                        } catch { /* Detached subresources aren't main documents. */ }
                    });
                    page.on("requestfailed", (req: any) => {
                        if (row.failedRequests.length < 30) row.failedRequests.push({ url: redact(req.url()), error: req.failure()?.errorText });
                    });
                }],
                requestHandler: (context: any) => capture(context),
                failedRequestHandler: (context: any, error: Error) => capture(context, error),
            });
            await engine.init();
            await engine.run();
        } catch (error) { row.status = "runtime_error"; row.error = redact(String(error)); }
        finally {
            await engine?.stop().catch((error: unknown) => { row.cleanupError = redact(String(error)); });
            await queue.drop();
            row.elapsedMs = Date.now() - started;
            await save();
            console.log(JSON.stringify({ round, target: target.id, implementation: implementation.label, success: row.success,
                httpStatus: row.httpStatus, status: row.status, elapsedMs: row.elapsedMs, error: row.error }));
        }
    }
}
await save();
console.log(`Journal-access report: ${directory}/report.json`);
// This standalone engine test owns its process; all pages and queues have been closed above.
process.exit(records.every((row) => row.success) ? 0 : 1);
