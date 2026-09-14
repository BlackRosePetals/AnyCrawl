import { describe, expect, it } from '@jest/globals';
import { mayStartBrowserTask } from '../../core/BrowserTaskGuard.js';

describe('browser task admission', () => {
    it.each(['completed', 'failed', 'cancelled'])('skips a %s task', async status => {
        expect(await mayStartBrowserTask({ jobId: 'job' }, async () => ({ status }))).toBe(false);
    });
    it('skips children of cancelled parents', async () => {
        expect(await mayStartBrowserTask({ jobId: 'child', parentId: 'parent' }, async id =>
            ({ status: id === 'parent' ? 'cancelled' : 'pending' }))).toBe(false);
    });
    it('preserves the original deadline on retries', async () => {
        const data = { jobId: 'job', _anycrawlJobDeadlineAt: 100 };
        expect(await mayStartBrowserTask(data, async () => ({ status: 'pending' }), 99)).toBe(true);
        await expect(mayStartBrowserTask(data, async () => ({ status: 'pending' }), 100))
            .rejects.toMatchObject({ name: 'BrowserTaskExpiredError' });
        expect(data._anycrawlJobDeadlineAt).toBe(100);
    });
    it('does not admit tasks on database errors', async () => {
        await expect(mayStartBrowserTask({ jobId: 'job' }, async () => { throw Error('database unavailable'); }))
            .rejects.toThrow('database unavailable');
    });
});
