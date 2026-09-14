import { NonRetryableError } from 'crawlee';

export class BrowserTaskExpiredError extends NonRetryableError {
    constructor() { super('Browser task deadline exceeded'); this.name = 'BrowserTaskExpiredError'; }
}

/** Caller-supplied hooks keep admission tests independent of live databases. */
export async function mayStartBrowserTask(
    data: Record<string, any>,
    lookup: (id: string) => Promise<{ status: string } | undefined>,
    now = Date.now(),
): Promise<boolean> {
    if (data.jobId) {
        const job = await lookup(data.jobId);
        if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) return false;
        if (data.parentId && data.parentId !== data.jobId) {
            const parent = await lookup(data.parentId);
            if (parent && ['completed', 'failed', 'cancelled'].includes(parent.status)) return false;
        }
    }
    if (Number.isFinite(data._anycrawlJobDeadlineAt) && now >= data._anycrawlJobDeadlineAt) {
        throw new BrowserTaskExpiredError();
    }
    return true;
}
