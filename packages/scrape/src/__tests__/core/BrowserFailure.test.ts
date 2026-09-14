import { describe, expect, it } from '@jest/globals';
import { browserFailureDetails, BrowserStartupError, isolateBrowserLaunchFailure } from '../../core/BrowserFailure.js';

describe('browser startup failure isolation', () => {
    it('bounds opt-in metadata retries to three attempts', async () => {
        const fatal = new Error('launch', { cause: Object.assign(new Error('missing'), { code: 'CLOAK_GEOIP_METADATA_MISSING' }) });
        fatal.name = 'BrowserLaunchError';
        let attempts = 0;
        const delays: number[] = [];
        const request = { userData: { options: { retry: true } } };
        await expect(isolateBrowserLaunchFailure(request, async () => { attempts++; throw fatal; }, () => {}, async ms => { delays.push(ms); }))
            .rejects.toMatchObject({ name: 'BrowserStartupError' });
        expect(attempts).toBe(3);
        expect(delays).toEqual([1000, 2000]);
    });

    it('allows a later startup attempt to succeed without replaying completed work', async () => {
        const fatal = new Error('launch', { cause: Object.assign(new Error('missing'), { code: 'CLOAK_GEOIP_METADATA_MISSING' }) });
        fatal.name = 'BrowserLaunchError';
        let attempts = 0;
        const result = await isolateBrowserLaunchFailure({ userData: { options: { retry: true } } }, async () => {
            if (++attempts === 1) throw fatal;
            return 'ready';
        }, () => {}, async () => {});
        expect(result).toBe('ready');
        expect(attempts).toBe(2);
    });
    it('preserves the SDK cause without retaining its fatal error class', async () => {
        const cause = Object.assign(new Error('GeoIP resolution failed: could not determine locale'), { code: 'CLOAK_GEOIP_METADATA_MISSING' });
        const fatal = new Error('Failed to launch browser', { cause });
        fatal.name = 'BrowserLaunchError';
        const request = { noRetry: false };
        const reports: unknown[] = [];
        await expect(isolateBrowserLaunchFailure(request, async () => { throw fatal; }, details => reports.push(details)))
            .rejects.toMatchObject({ name: 'BrowserStartupError', cause: { name: 'BrowserLaunchError', cause: { code: 'CLOAK_GEOIP_METADATA_MISSING' } } });
        expect(request.noRetry).toBe(true);
        expect(reports).toHaveLength(1);
        expect(new BrowserStartupError(fatal).message).toBe('Browser startup failed');
    });

    it('does not swallow navigation, cancellation or application errors', async () => {
        const error = new Error('cancelled');
        const request = { noRetry: false };
        await expect(isolateBrowserLaunchFailure(request, async () => { throw error; }, () => {})).rejects.toBe(error);
        expect(request.noRetry).toBe(false);
    });

    it('redacts nested credentials, bounds output, and handles cyclic causes', () => {
        const inner: any = new Error('http://user:password@proxy.example:80/path?token=secret');
        inner.stack = 'Proxy-Authorization: Basic SECRET\n' + 'x'.repeat(20000);
        const outer = new Error('launch', { cause: inner });
        inner.cause = outer;
        const details = browserFailureDetails(outer);
        const serialized = JSON.stringify(details);
        expect(details.causes).toHaveLength(2);
        expect(serialized).not.toMatch(/password|SECRET|token=secret/);
        expect(details.causes[1].stack.length).toBeLessThanOrEqual(6000);
        expect(JSON.stringify(browserFailureDetails(new BrowserStartupError(outer)))).not.toMatch(/password|SECRET|token=secret/);
    });
});
