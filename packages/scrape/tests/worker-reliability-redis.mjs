import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { ProgressManager } from '../dist/managers/Progress.js';

if (!process.env.ANYCRAWL_REDIS_URL) throw new Error('ANYCRAWL_REDIS_URL is required; no alternate Redis is selected');
const redis = new Redis(process.env.ANYCRAWL_REDIS_URL, { lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 0, connectTimeout: 10000 });
let connectionError;
redis.on('error', error => { connectionError = error; });
const manager = Object.create(ProgressManager.prototype);
manager.redis = redis;
const jobId = `reliability-test:${randomUUID()}`;
const key = `crawl:${jobId}`;
try {
    try { await redis.connect(); }
    catch { throw new Error(`Redis connection failed: ${connectionError?.code ?? "CONNECTION_CLOSED"}`); }
    await Promise.all(Array.from({ length: 30 }, () => manager.ensureSeedEnqueued(jobId)));
    assert.equal(await manager.getEnqueued(jobId), 1);
    await manager.incrementEnqueued(jobId, 3);
    await manager.ensureSeedEnqueued(jobId);
    assert.equal(await manager.getEnqueued(jobId), 4);
    console.log('PASS: 30 concurrent handoffs count one seed and preserve discovered pages');
} finally {
    try { if (redis.status === 'ready') await redis.del(key); }
    finally { redis.disconnect(); }
}
