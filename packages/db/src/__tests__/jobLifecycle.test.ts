import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { eq, sql } from 'drizzle-orm';
import { STATUS } from '../map.js';

const jobs = sqliteTable('jobs', {
    jobId: text('job_id').primaryKey(), status: text('status').notNull(),
    isSuccess: integer('is_success', { mode: 'boolean' }), errorMessage: text('error_message'),
    total: integer('total'), completed: integer('completed'), failed: integer('failed'),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
});
const connection = new Database(':memory:');
connection.exec('CREATE TABLE jobs (job_id TEXT PRIMARY KEY, status TEXT NOT NULL, is_success INTEGER, error_message TEXT, total INTEGER, completed INTEGER, failed INTEGER, updated_at INTEGER)');
const db = drizzle(connection);
jest.unstable_mockModule('../index.js', () => ({ getDB: async () => db, schemas: { jobs }, eq, sql, STATUS }));
const { Job } = await import('../model/Job.js');
beforeEach(() => { connection.exec("DELETE FROM jobs; INSERT INTO jobs(job_id,status,is_success) VALUES ('job','pending',0)"); });
afterAll(() => { connection.close(); });

describe('job terminal state transitions in a real database', () => {
    it.each(['failed', 'cancelled', 'completed'])('does not overwrite %s with a late transition', async status => {
        db.update(jobs).set({ status }).where(eq(jobs.jobId, 'job')).run();
        await Job.markAsCompleted('job', true, { completed: 1 });
        await Job.markAsFailed('job', 'late timeout');
        await Job.markAsPending('job');
        await Job.cancel('job');
        expect(db.select().from(jobs).get()).toMatchObject({ status });
    });
    it('keeps the first winner when completion and timeout compete', async () => {
        await Promise.all([Job.markAsCompleted('job', true), Job.markAsFailed('job', 'timeout')]);
        const first = db.select().from(jobs).get();
        await Promise.all([Job.markAsFailed('job', 'late timeout'), Job.markAsCompleted('job', true)]);
        expect(db.select().from(jobs).get()).toEqual(first);
    });
});
