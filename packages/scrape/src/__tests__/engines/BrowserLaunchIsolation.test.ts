import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { BrowserLaunchError, Configuration, PlaywrightCrawler, PuppeteerCrawler } from 'crawlee';
import { ResilientPlaywrightCrawler, ResilientPuppeteerCrawler } from '../../engines/ResilientBrowserCrawler.js';

afterEach(() => jest.restoreAllMocks());

describe.each([
    ['playwright', PlaywrightCrawler, ResilientPlaywrightCrawler],
    ['puppeteer', PuppeteerCrawler, ResilientPuppeteerCrawler],
] as const)('%s launch failure', (_name, Parent, Resilient) => {
    it('fails one request and continues consuming the next in the real Crawlee loop', async () => {
        const handled: string[] = [];
        const failed: string[] = [];
        const root = Object.assign(new Error('GeoIP resolution failed: could not determine locale'), { code: 'CLOAK_GEOIP_METADATA_MISSING' });
        jest.spyOn(Parent.prototype as any, '_runRequestHandler').mockImplementation(async (context: any) => {
            if (context.request.url.endsWith('/bad')) throw new BrowserLaunchError('launch failed', { cause: root });
            handled.push(context.request.url);
        });
        const crawler = new Resilient({
            maxConcurrency: 1, useSessionPool: false,
            requestHandler: async () => {},
            failedRequestHandler: async ({ request }) => { failed.push(request.url); },
        }, new Configuration({ persistStorage: false }));
        await crawler.run(['https://example.com/bad', 'https://example.com/good']);
        expect(failed).toEqual(['https://example.com/bad']);
        expect(handled).toEqual(['https://example.com/good']);
    }, 30000);
});
