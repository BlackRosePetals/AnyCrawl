import type { Page } from "playwright";

/** Self-contained: also serialized into a Worker; no external probes. */
export async function runtimeSnapshot() {
    const nav = navigator as Navigator & { deviceMemory?: number; webkitTemporaryStorage?: any };
    const graphics = (type: "webgl" | "webgl2") => {
        try {
            const canvas =
                typeof document === "undefined"
                    ? new OffscreenCanvas(32, 32)
                    : Object.assign(document.createElement("canvas"), { width: 32, height: 32 });
            const gl = canvas.getContext(type) as
                | WebGLRenderingContext
                | WebGL2RenderingContext
                | null;
            if (!gl) return { available: false, reason: "context unavailable" };
            const debug = gl.getExtension("WEBGL_debug_renderer_info");
            gl.clearColor(0.25, 0.5, 0.75, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            const pixels = new Uint8Array(4);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            const result = {
                available: true,
                vendor: debug
                    ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
                    : gl.getParameter(gl.VENDOR),
                renderer: debug
                    ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
                    : gl.getParameter(gl.RENDERER),
                version: gl.getParameter(gl.VERSION),
                maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
                extensions: gl.getSupportedExtensions(),
                pixel: Array.from(pixels),
                error: gl.getError(),
                contextLost: gl.isContextLost(),
            };
            gl.getExtension("WEBGL_lose_context")?.loseContext();
            return result;
        } catch (error) {
            return { available: false, reason: String(error) };
        }
    };
    let storage: unknown;
    try {
        storage = nav.storage?.estimate ? await nav.storage.estimate() : { unavailable: true };
    } catch (error) {
        storage = { unavailable: true, reason: String(error) };
    }
    const legacyQuota = await new Promise<unknown>((resolve) => {
        if (!nav.webkitTemporaryStorage?.queryUsageAndQuota) {
            resolve({ unavailable: true });
            return;
        }
        const timer = setTimeout(() => resolve({ unavailable: true, reason: "timeout" }), 1000);
        nav.webkitTemporaryStorage.queryUsageAndQuota(
            (usage: number, quota: number) => {
                clearTimeout(timer);
                resolve({ usage, quota });
            },
            (error: unknown) => {
                clearTimeout(timer);
                resolve({ unavailable: true, reason: String(error) });
            }
        );
    });
    return {
        userAgent: nav.userAgent,
        platform: nav.platform,
        languages: Array.from(nav.languages),
        hardwareConcurrency: nav.hardwareConcurrency,
        deviceMemory: nav.deviceMemory,
        storage,
        legacyQuota,
        storageBucketsAvailable: "storageBuckets" in nav,
        webgl: graphics("webgl"),
        webgl2: graphics("webgl2"),
    };
}

/** Run after external scores are collected, so diagnostics do not affect their measurement. */
export async function collectRuntimeDiagnostics(page: Page) {
    // tsx/esbuild keeps function names via __name; include that local helper when serializing.
    const source = `(() => { const __name = (fn) => fn; return (${runtimeSnapshot.toString()})(); })()`;
    const main = (await page.evaluate(source)) as Awaited<ReturnType<typeof runtimeSnapshot>>;
    const worker = await page.evaluate(async (source) => {
        const url = URL.createObjectURL(
            new Blob(
                [
                    `${source}.then(value => postMessage({value}), error => postMessage({error:String(error)}))`,
                ],
                { type: "text/javascript" }
            )
        );
        let worker: Worker | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await new Promise<unknown>((resolve) => {
                timer = setTimeout(
                    () => resolve({ unavailable: true, reason: "Worker timed out or was blocked" }),
                    3000
                );
                worker = new Worker(url);
                worker.onmessage = (event) => resolve(event.data);
                worker.onerror = (event) => {
                    event.preventDefault();
                    resolve({ unavailable: true, reason: event.message });
                };
            });
        } catch (error) {
            return { unavailable: true, reason: String(error) };
        } finally {
            if (timer) clearTimeout(timer);
            worker?.terminate();
            URL.revokeObjectURL(url);
        }
    }, source);
    let iframe: unknown;
    const handle = await page.evaluateHandle(() => {
        const frame = document.createElement("iframe");
        frame.hidden = true;
        document.body.appendChild(frame);
        return frame;
    });
    try {
        const frame = await handle.asElement()?.contentFrame();
        iframe = frame
            ? await frame.evaluate(source)
            : { unavailable: true, reason: "iframe unavailable" };
    } catch (error) {
        iframe = { unavailable: true, reason: String(error) };
    } finally {
        await handle.evaluate((frame) => frame.remove()).catch(() => {});
        await handle.dispose();
    }
    return { main, worker, iframe };
}
