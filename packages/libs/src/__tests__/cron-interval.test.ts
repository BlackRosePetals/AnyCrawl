import { describe, expect, it } from '@jest/globals';
import { cronIntervalMinutes } from '../plan-limits.js';

/**
 * Mirrors MONITOR_FREQUENCY_PRESETS in the dashboard
 * (apps/web/lib/monitors/frequency.ts). If a preset is added there without a
 * row here, the gate has never been checked against it.
 */
const PRESETS: Array<[label: string, cron: string, minutes: number]> = [
    ['every_15_minutes', '*/15 * * * *', 15],
    ['every_30_minutes', '*/30 * * * *', 30],
    ['hourly', '0 * * * *', 60],
    ['every_2_hours', '0 */2 * * *', 120],
    ['every_6_hours', '0 */6 * * *', 360],
    ['every_12_hours', '0 */12 * * *', 720],
    ['daily', '0 9 * * *', 1440],
    ['weekly', '0 9 * * 1', 10080],
];

/** Must stay in sync with DEFAULT_PLAN_LIMITS.minMonitorIntervalMinutes. */
const FLOORS = { free: 360, hobby: 60, pro: 15, business: 15 };

describe('cronIntervalMinutes', () => {
    it.each(PRESETS)('%s resolves to %s → %i minutes', (_label, cron, minutes) => {
        expect(cronIntervalMinutes(cron)).toBe(minutes);
    });

    // Evaluated in UTC on purpose: a wall-clock schedule in a DST timezone
    // compresses one gap by an hour twice a year (Sydney's weekly preset drops to
    // 10,020, and a 6-hour step to 300), which would 403 the dashboard's own
    // default preset for a week. The floor is about nominal cadence.
    it('is unaffected by the process timezone', () => {
        const previous = process.env.TZ;
        try {
            for (const tz of ['UTC', 'America/New_York', 'Australia/Sydney']) {
                process.env.TZ = tz;
                for (const [, cron, minutes] of PRESETS) {
                    expect(cronIntervalMinutes(cron)).toBe(minutes);
                }
            }
        } finally {
            process.env.TZ = previous;
        }
    });

    it('returns null for an unparseable expression rather than throwing', () => {
        expect(cronIntervalMinutes('not a cron')).toBeNull();
    });

    // cron-parser reads an empty expression as every minute; it must be rejected
    // by every tier rather than treated as unparseable and waved through.
    it('treats an empty expression as every minute, which no plan allows', () => {
        expect(cronIntervalMinutes('')).toBe(1);
    });
});

describe('every preset is decided the same way the controller decides it', () => {
    const allowed = (cron: string, floor: number) => {
        const interval = cronIntervalMinutes(cron);
        return interval === null || interval >= floor;
    };

    it('free allows 6 hours and slower — including the dashboard default', () => {
        const permitted = PRESETS.filter(([, cron]) => allowed(cron, FLOORS.free)).map(([label]) => label);
        expect(permitted).toEqual(['every_6_hours', 'every_12_hours', 'daily', 'weekly']);
        // The create-monitor form defaults to this; a free user who changes
        // nothing must not get a 403.
        expect(allowed('0 */6 * * *', FLOORS.free)).toBe(true);
    });

    it('hobby allows hourly and slower', () => {
        const permitted = PRESETS.filter(([, cron]) => allowed(cron, FLOORS.hobby)).map(([label]) => label);
        expect(permitted).toEqual(['hourly', 'every_2_hours', 'every_6_hours', 'every_12_hours', 'daily', 'weekly']);
    });

    it.each(['pro', 'business'] as const)('%s allows every preset', tier => {
        expect(PRESETS.every(([, cron]) => allowed(cron, FLOORS[tier]))).toBe(true);
    });

    // Boundaries are `interval < floor` → reject, so an exact match must pass.
    it('accepts an interval exactly equal to the floor', () => {
        expect(allowed('0 */6 * * *', 360)).toBe(true);
        expect(allowed('0 * * * *', 60)).toBe(true);
        expect(allowed('*/15 * * * *', 15)).toBe(true);
    });
});
