import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import net from 'node:net';

type FixtureOptions = { noRecord?: boolean; lookupError?: boolean; readError?: boolean; ipUnavailable?: boolean; proxyStatus?: number };

// Execute the installed SDK unchanged, replacing only external I/O. Both browser
// drivers share this module; no browser dependency or target website is needed.
async function geoipFixture(country: string | null, timezone: string | null, fixture: FixtureOptions = {}) {
    const source = readFileSync(new URL('../../../node_modules/cloakbrowser/dist/geoip.js', import.meta.url), 'utf8');
    const warnings: string[] = [];
    const calls = { echo: 0, lookup: 0, proxy: 0 };
    const context = createContext({
        process: { env: {} }, console: { ...console, warn: (value: string) => warnings.push(value) },
        Buffer, URL, AbortController, performance, setTimeout, clearTimeout,
        fetch: async () => {
            calls.echo++;
            if (fixture.ipUnavailable) throw new Error('IP echo unavailable');
            return { ok: true, text: async () => '192.0.2.1' };
        },
    });
    const synthetic = async (values: Record<string, any>) => {
        const module = new SyntheticModule(Object.keys(values), function () {
            for (const [key, value] of Object.entries(values)) this.setExport(key, value);
        }, { context });
        await module.link(() => { throw new Error('Unexpected nested dependency'); });
        await module.evaluate();
        return module;
    };
    const fs = {
        existsSync: () => true, statSync: () => ({ mtimeMs: Date.now() }),
        readFileSync: () => {
            if (fixture.readError) throw new Error('GeoIP database unreadable');
            return Buffer.alloc(1);
        },
    };
    const deps: Record<string, any> = {
        'node:fs': { default: fs, createWriteStream: () => { throw Error('Unexpected download'); } },
        'node:path': { default: path }, 'node:net': { default: net },
        'node:dns/promises': { default: { lookup: async () => { throw new Error('Proxy DNS unavailable'); } } },
        'node:http': { default: { request: () => {
            calls.proxy++;
            const request: any = new EventEmitter();
            request.end = () => queueMicrotask(() => {
                if (fixture.proxyStatus) request.emit('connect', { statusCode: fixture.proxyStatus }, { destroy() {} });
                else request.emit('error', new Error('Proxy connection rejected'));
            });
            return request;
        } } },
        'node:https': { default: { request: () => {
            const request: any = new EventEmitter();
            request.end = () => queueMicrotask(() => request.emit('error', new Error('Proxy tunnel rejected')));
            return request;
        } } },
        './config.js': { getCacheDir: () => '/fixture' },
        './proxy.js': { ensureProxyScheme: (s: string) => s, isSocksProxy: () => false, reconstructHttpUrl: () => '', reconstructSocksUrl: () => '' },
        'mmdb-lib': { Reader: class { get() {
            calls.lookup++;
            if (fixture.lookupError) throw new Error('GeoIP database corrupt');
            return fixture.noRecord ? null : { country: { iso_code: country }, location: { time_zone: timezone } };
        } } },
    };
    const module = new SourceTextModule(source, {
        context,
        importModuleDynamically: async name => {
            if (!deps[name]) throw new Error(`Unexpected I/O module: ${name}`);
            return synthetic(deps[name]);
        },
    });
    await module.link(async name => {
        if (!deps[name]) throw new Error(`Unexpected dependency: ${name}`);
        return synthetic(deps[name]);
    });
    await module.evaluate();
    const sdk = module.namespace as unknown as { maybeResolveGeoip(options: any): Promise<any> };
    return { sdk, warnings, calls };
}

describe('locked CloakBrowser GeoIP defaults', () => {
    it.each([
        ['ML', 'Africa/Bamako', 'Africa/Bamako', 'fr-ML', []],
        ['BR', 'America/Bahia', 'America/Bahia', 'pt-BR', []],
        ['ZZ', 'Asia/Singapore', 'Asia/Singapore', 'en-US', ['locale']],
        ['ML', null, 'UTC', 'fr-ML', ['timezone']],
        [null, null, 'UTC', 'en-US', ['timezone', 'locale']],
    ])('fills only missing metadata for country=%s timezone=%s', async (country, timezone, expectedTimezone, locale, missing) => {
        const { sdk, warnings, calls } = await geoipFixture(country as string | null, timezone as string | null);
        expect(await sdk.maybeResolveGeoip({ geoip: true })).toEqual({ timezone: expectedTimezone, locale, exitIp: '192.0.2.1' });
        expect(calls).toEqual({ echo: 1, lookup: 1, proxy: 0 });
        if ((missing as string[]).length) {
            expect(warnings).toHaveLength(1);
            expect(JSON.parse(warnings[0]!)).toMatchObject({ event: 'geoip_metadata_defaulted', missing, count: 1 });
            expect(warnings[0]).not.toMatch(/192\.0\.2\.1|stack|Error:/);
        } else expect(warnings).toEqual([]);
    });

    it('continues on an IP with no MMDB record, retaining the same exit IP', async () => {
        const { sdk, calls } = await geoipFixture(null, null, { noRecord: true });
        expect(await sdk.maybeResolveGeoip({ geoip: true })).toEqual({ timezone: 'UTC', locale: 'en-US', exitIp: '192.0.2.1' });
        expect(calls.echo).toBe(1);
    });

    it('preserves explicit fields and raw browser flags', async () => {
        const { sdk, warnings } = await geoipFixture(null, null);
        expect(await sdk.maybeResolveGeoip({ geoip: true, locale: 'de-DE' })).toMatchObject({ timezone: 'UTC', locale: 'de-DE' });
        expect(await sdk.maybeResolveGeoip({ geoip: true, timezone: 'Asia/Tokyo' })).toMatchObject({ timezone: 'Asia/Tokyo', locale: 'en-US' });
        expect(await sdk.maybeResolveGeoip({ geoip: true, args: ['--fingerprint-timezone=Europe/Berlin', '--lang=de-DE'] }))
            .toEqual({ timezone: 'Europe/Berlin', locale: 'de-DE' });
        expect(warnings.map(value => JSON.parse(value).count)).toEqual([1, 2]);
        expect(JSON.parse(warnings[0]!).defaults).toEqual({ timezone: 'UTC' });
        expect(JSON.parse(warnings[1]!).defaults).toEqual({ locale: 'en-US' });
    });

    it('does nothing when GeoIP is disabled', async () => {
        const { sdk, calls, warnings } = await geoipFixture(null, null);
        expect(await sdk.maybeResolveGeoip({ geoip: false })).toEqual({ timezone: undefined, locale: undefined });
        expect(calls.echo).toBe(0);
        expect(warnings).toEqual([]);
    });

    it.each([{ lookupError: true }, { readError: true }, { ipUnavailable: true }])('does not default after operational failure %j', async fixture => {
        const { sdk, warnings } = await geoipFixture(null, null, fixture);
        await expect(sdk.maybeResolveGeoip({ geoip: true })).rejects.toThrow(/GeoIP/);
        expect(warnings).toEqual([]);
    });

    it.each([undefined, 407, 502])('does not default or use the gateway IP after proxy failure %s', async proxyStatus => {
        const { sdk, warnings, calls } = await geoipFixture(null, null, { proxyStatus });
        await expect(sdk.maybeResolveGeoip({ geoip: true, proxy: 'http://user:secret@192.0.2.99:80' })).rejects.toThrow(/GeoIP/);
        expect(calls.proxy).toBeGreaterThan(0);
        expect(calls.echo).toBe(0);
        expect(calls.lookup).toBe(0);
        expect(warnings).toEqual([]);
    });
});
