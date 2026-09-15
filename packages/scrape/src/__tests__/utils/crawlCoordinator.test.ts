import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { crawlSchema } from '@anycrawl/libs';

const queued: any[] = [];
let graph: Record<string, string[]>;
const complete = jest.fn<any>();
const fail = jest.fn<any>();
const finalizeDataset = jest.fn<any>();
const resolveEngine = jest.fn<any>();
const wait = jest.fn<any>();
jest.unstable_mockModule('./src/managers/Queue.js', () => ({
    QueueManager: { getInstance: () => ({
        addJob: async (queue: string, data: any) => { queued.push({ queue, data }); return String(queued.length - 1); },
        waitJobDone: wait,
    }) },
}));
jest.unstable_mockModule('./src/utils/autoEngine.js', () => ({ resolveAutoEngine: resolveEngine }));
jest.unstable_mockModule('@anycrawl/db', () => ({
    completedJob: complete, failedJob: fail, finalizeCrawlDatasetRun: finalizeDataset,
}));
const { runAutoCrawl } = await import('../../utils/crawlCoordinator.js');
const seed = 'https://example.com/';
const urls = () => queued.map(x => x.data.url);
const payload = (options: Record<string, unknown> = {}) => crawlSchema.parse({ url: seed, engine: 'auto', ...options });

beforeEach(() => {
    queued.length = 0; graph = {};
    complete.mockReset(); fail.mockReset(); finalizeDataset.mockReset();
    resolveEngine.mockReset(); resolveEngine.mockResolvedValue('cheerio');
    wait.mockReset(); wait.mockImplementation(async (_q: string, id: string) => ({ status: 'completed', links: graph[queued[Number(id)].data.url] || [] }));
});

describe('auto crawl consumes the production schema contract', () => {
    it.each([1, 2])('never schedules more than limit=%s pages', async limit => {
        graph[seed] = Array.from({ length: 20 }, (_, i) => `${seed}${i}`);
        await runAutoCrawl('parent', payload({ limit }));
        expect(queued).toHaveLength(limit);
        expect(complete).toHaveBeenCalledWith('parent', true, { total: limit, completed: limit, failed: 0 });
        expect(fail).not.toHaveBeenCalled();
    });

    it('uses schema defaults instead of an unrelated ten-page fallback', async () => {
        const p = payload(); expect(p.options.limit).toBe(100);
        graph[seed] = Array.from({ length: 12 }, (_, i) => `${seed}${i}`);
        await runAutoCrawl('parent', p);
        expect(queued).toHaveLength(13);
    });

    it('stops expanding links at the requested depth', async () => {
        graph = { [seed]: [`${seed}a`], [`${seed}a`]: [`${seed}deep`] };
        await runAutoCrawl('parent', payload({ limit: 20, max_depth: 1 }));
        expect(urls()).toEqual([seed, `${seed}a`]);
    });

    it('applies include and exclude patterns before queueing children', async () => {
        graph[seed] = [`${seed}keep/a`, `${seed}keep/blocked`, `${seed}other`];
        await runAutoCrawl('parent', payload({ include_paths: [`${seed}keep/**`], exclude_paths: [`${seed}keep/blocked`] }));
        expect(urls()).toEqual([seed, `${seed}keep/a`]);
    });

    it.each([
        ['same-origin', [seed, `${seed}a`]],
        ['same-hostname', [seed, `${seed}a`, 'http://example.com/b']],
        ['all', [seed, `${seed}a`, 'http://example.com/b', 'https://other.example/c']],
    ])('honors strategy %s', async (strategy, expected) => {
        graph[seed] = [`${seed}a`, 'http://example.com/b', 'https://other.example/c'];
        await runAutoCrawl('parent', payload({ strategy }));
        expect(urls()).toEqual(expected);
    });

    it('flattens page options for the scrape queue and preserves existing metadata', async () => {
        const p = payload({ limit: 2, template_id: 'crawl-template', scrape_paths: [`${seed}keep/**`], scrape_options: { proxy: 'http://proxy.example:8080', formats: ['html'], timeout: 7000, max_age: 0, include_tags: ['main'] } });
        const dataset = { datasetId: 'dataset', scopeType: 'crawl', mapping: {}, owner: {} };
        Object.assign(p.options, { dataset });
        const original = JSON.stringify(p);
        await runAutoCrawl('parent', p);
        const child = queued[0].data;
        expect(child).toMatchObject({ parentId: 'parent', type: 'scrape', options: { limit: 2, template_id: 'crawl-template', dataset, scrape_paths: [`${seed}keep/**`] } });
        expect(child.options).toMatchObject({ proxy: 'http://proxy.example:8080', formats: ['html', 'links'], timeout: 7000, max_age: 0, include_tags: ['main'] });
        expect(resolveEngine).toHaveBeenCalledWith(seed, 'http://proxy.example:8080');
        expect(wait).toHaveBeenCalledWith('scrape-cheerio', '0', 7000);
        expect(finalizeDataset).toHaveBeenCalledWith({ datasetId: 'dataset', producerType: 'crawl', producerId: 'parent' });
        expect(JSON.stringify(p)).toBe(original);
    });
});
