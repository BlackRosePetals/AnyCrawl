import { PlaywrightCrawler, PuppeteerCrawler, log, type PlaywrightCrawlingContext, type PuppeteerCrawlingContext } from 'crawlee';
import { isolateBrowserLaunchFailure } from '../core/BrowserFailure.js';
import { mayStartBrowserTask } from '../core/BrowserTaskGuard.js';

async function mayStart(context: PlaywrightCrawlingContext | PuppeteerCrawlingContext): Promise<boolean> {
    if (!context.request.userData.jobId) return true;
    const { getJob } = await import('@anycrawl/db');
    return mayStartBrowserTask(context.request.userData, getJob);
}

export class ResilientPlaywrightCrawler extends PlaywrightCrawler {
    protected override async _runRequestHandler(context: PlaywrightCrawlingContext): Promise<void> {
        context.request.userData._anycrawlStartupDeadlineAt ??= Date.now() + this.requestHandlerTimeoutMillis;
        if (!await mayStart(context)) return;
        await isolateBrowserLaunchFailure(context.request, () => super._runRequestHandler(context),
            details => log.error('Playwright browser startup failed', details));
    }
}

export class ResilientPuppeteerCrawler extends PuppeteerCrawler {
    protected override async _runRequestHandler(context: PuppeteerCrawlingContext): Promise<void> {
        context.request.userData._anycrawlStartupDeadlineAt ??= Date.now() + this.requestHandlerTimeoutMillis;
        if (!await mayStart(context)) return;
        await isolateBrowserLaunchFailure(context.request, () => super._runRequestHandler(context),
            details => log.error('Puppeteer browser startup failed', details));
    }
}
