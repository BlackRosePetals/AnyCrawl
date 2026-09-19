import { afterEach, describe, expect, it } from '@jest/globals';
import {
    getPlanLimits,
    checkPlanFeatures,
    validatePlanLimitsConfig,
    isPlanTier,
    UNLIMITED_PLAN_LIMITS,
} from '../plan-limits.js';

const original = process.env;
afterEach(() => { process.env = original; });

/** Turn the gate on; without this every lookup short-circuits to unlimited. */
function enabled(extra: Record<string, string> = {}) {
    process.env = { ...original, ANYCRAWL_API_PLAN_LIMITS_ENABLED: 'true', ...extra };
}

describe('plan limits are inert unless switched on', () => {
    it('returns unlimited when the switch is absent — the self-hosted default', () => {
        process.env = { ...original };
        delete process.env.ANYCRAWL_API_PLAN_LIMITS_ENABLED;
        expect(getPlanLimits('free')).toBe(UNLIMITED_PLAN_LIMITS);
        expect(getPlanLimits(null)).toBe(UNLIMITED_PLAN_LIMITS);
    });

    it.each(['false', 'TRUE', '1', 'yes', ''])('stays off for a non-"true" value %p', value => {
        process.env = { ...original, ANYCRAWL_API_PLAN_LIMITS_ENABLED: value };
        expect(getPlanLimits('free')).toBe(UNLIMITED_PLAN_LIMITS);
    });

    it('never gates a feature while unlimited', () => {
        expect(checkPlanFeatures({ proxy: 'stealth' }, UNLIMITED_PLAN_LIMITS)).toBeNull();
    });
});

describe('tier resolution', () => {
    it('falls back to free for an unknown tier', () => {
        enabled();
        expect(getPlanLimits('enterprise').stealthProxy).toBe(false);
        expect(getPlanLimits(undefined).stealthProxy).toBe(false);
    });

    // A redeem code storing "Pro" must not silently degrade the user to free.
    it.each(['Pro', 'PRO', 'pro'])('matches a tier case-insensitively: %s', tier => {
        enabled();
        expect(isPlanTier(tier)).toBe(true);
        expect(getPlanLimits(tier).monitors).toBe(50);
    });
});

describe('stealth proxy gate', () => {
    it('blocks stealth on free and allows it from hobby up', () => {
        enabled();
        expect(checkPlanFeatures({ proxy: 'stealth' }, getPlanLimits('free')))
            .toMatchObject({ code: 'stealth_proxy_not_allowed' });
        for (const tier of ['hobby', 'pro', 'business']) {
            expect(checkPlanFeatures({ proxy: 'stealth' }, getPlanLimits(tier))).toBeNull();
        }
    });

    it.each([undefined, 'auto', 'base', 'http://user:pass@proxy:8080'])
        ('leaves proxy %p alone on free', proxy => {
            enabled();
            expect(checkPlanFeatures({ proxy }, getPlanLimits('free'))).toBeNull();
        });

    it('tolerates a missing options object', () => {
        enabled();
        expect(checkPlanFeatures(undefined, getPlanLimits('free'))).toBeNull();
        expect(checkPlanFeatures(null, getPlanLimits('free'))).toBeNull();
    });
});

describe('ANYCRAWL_PLAN_LIMITS_JSON', () => {
    it('applies a well-formed override', () => {
        enabled({ ANYCRAWL_PLAN_LIMITS_JSON: '{"pro":{"concurrency":40}}' });
        expect(getPlanLimits('pro').concurrency).toBe(40);
        // untouched fields keep their defaults
        expect(getPlanLimits('pro').monitors).toBe(50);
    });

    // A string "2" used to merge cleanly and then fail Number.isFinite at the call
    // site, silently turning the limit OFF. It must fail loudly instead.
    it.each([
        ['{"free":{"concurrency":"2"}}', 'free.concurrency'],
        ['{"free":{"monitors":null}}', 'free.monitors'],
        ['{"free":{"concurrency":-1}}', 'free.concurrency'],
        ['{"free":{"stealthProxy":"yes"}}', 'free.stealthProxy'],
        ['{"free":{"retentionDays":7}}', 'unknown limit'],
        ['{"gold":{"concurrency":1}}', 'unknown plan tier'],
        ['{"free":[]}', 'must be an object'],
        ['[]', 'keyed by plan tier'],
        ['not json', 'must be valid JSON'],
    ])('rejects %s', (json, message) => {
        enabled({ ANYCRAWL_PLAN_LIMITS_JSON: json });
        expect(() => validatePlanLimitsConfig()).toThrow(message);
    });
});
