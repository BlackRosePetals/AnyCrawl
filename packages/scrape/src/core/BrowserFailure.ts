/** Safe diagnostics at the SDK/Crawlee boundary. Never serialize an arbitrary error object. */
export function redactBrowserDiagnostic(value: unknown): string {
    return String(value ?? '')
        .replace(/(?:https?|socks[45]h?):\/\/[^\s<>"']+/gi, '[redacted-url]')
        .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie|password|api[_-]?key|token)\s*[:=]\s*[^\r\n]+/gi, '[redacted-secret]')
        .slice(0, 6000);
}

export function browserFailureDetails(error: unknown) {
    const causes: { name: string; message: string; stack: string; code?: string; countryCode?: string }[] = [];
    const seen = new Set<unknown>();
    let current: any = error;
    while (current && !seen.has(current) && causes.length < 4) {
        seen.add(current);
        causes.push({
            name: redactBrowserDiagnostic(current.name ?? 'Error'),
            message: redactBrowserDiagnostic(current.message ?? current),
            stack: redactBrowserDiagnostic(current.stack ?? ''),
            ...(typeof current.code === 'string' ? { code: redactBrowserDiagnostic(current.code) } : {}),
            ...(/^[A-Z]{2}$/.test(current.countryCode) ? { countryCode: current.countryCode } : {}),
        });
        current = current.cause;
    }
    return { causes };
}

function safeCause(error: Error): Error {
    let cause: Error | undefined;
    for (const entry of browserFailureDetails(error).causes.reverse()) {
        const copy = new Error(entry.message, { cause });
        copy.name = entry.name;
        copy.stack = entry.stack;
        Object.assign(copy, { code: entry.code, countryCode: entry.countryCode });
        cause = copy;
    }
    return cause!;
}

export function isBrowserLaunchFailure(error: unknown): error is Error {
    return error instanceof Error && error.name === 'BrowserLaunchError';
}

/**
 * Crawlee makes BrowserLaunchError a CriticalError, terminating the whole crawler.
 * A launch failure belongs to this request. Preserve its cause without inheriting
 * CriticalError, so Crawlee can run its normal failure/cleanup bookkeeping.
 */
export class BrowserStartupError extends Error {
    readonly code = 'BROWSER_STARTUP_FAILED';
    constructor(cause: Error) {
        // Crawlee also serializes cause chains into its own request/error logs.
        super('Browser startup failed', { cause: safeCause(cause) });
        this.name = 'BrowserStartupError';
    }
}

export async function isolateBrowserLaunchFailure<T>(
    request: { noRetry?: boolean; method?: string; userData?: Record<string, any> },
    run: () => Promise<T>,
    report: (details: ReturnType<typeof browserFailureDetails>) => void,
    wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await run();
        } catch (error) {
            if (!isBrowserLaunchFailure(error)) throw error;
            const details = browserFailureDetails(error);
            report(details);
            const data = request.userData ?? {};
            const deadline = Math.min(data._anycrawlJobDeadlineAt ?? Infinity, data._anycrawlStartupDeadlineAt ?? Infinity);
            const delay = 1000 * 2 ** attempt;
            const retry = data.options?.retry === true && !request.noRetry
                && ['GET', 'HEAD'].includes(request.method ?? 'GET')
                && !data._anycrawlSideEffectsStarted && !data._anycrawlExtractionStarted
                && attempt < 2 && Date.now() + delay < deadline
                && details.causes.some(cause => cause.code === 'CLOAK_GEOIP_METADATA_MISSING');
            if (retry) {
                await wait(delay);
                if (Date.now() < deadline && !request.noRetry) continue;
            }
            // Unknown failures are never mistaken for target blocking. Retry=false
            // and exhausted startup budgets also fail only the current request.
            request.noRetry = true;
            throw new BrowserStartupError(error);
        }
    }
}
