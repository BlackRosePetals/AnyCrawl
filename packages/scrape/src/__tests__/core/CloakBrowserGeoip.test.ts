import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import path from 'node:path';
import net from 'node:net';

// Execute the installed, patched SDK unchanged. Only I/O (IP echo, MMDB and
// filesystem) is replaced, so the country mapping and strict resolution run for real.
async function geoipFixture(country: string, timezone: string | null) {
    const source = readFileSync(new URL('../../../node_modules/cloakbrowser/dist/geoip.js', import.meta.url), 'utf8');
    const context = createContext({
        process: { env: {} }, console, Buffer, URL, AbortController, performance, setTimeout, clearTimeout,
        fetch: async () => ({ ok: true, text: async () => '192.0.2.1' }),
    });
    const synthetic = async (values: Record<string, any>) => {
        const module = new SyntheticModule(Object.keys(values), function () {
            for (const [key, value] of Object.entries(values)) this.setExport(key, value);
        }, { context });
        await module.link(() => { throw new Error('Unexpected nested dependency'); });
        await module.evaluate();
        return module;
    };
    const fs = { existsSync: () => true, statSync: () => ({ mtimeMs: Date.now() }), readFileSync: () => Buffer.alloc(1) };
    const deps: Record<string, any> = {
        'node:fs': { default: fs, createWriteStream: () => { throw Error('Unexpected download'); } },
        'node:path': { default: path }, 'node:net': { default: net }, 'node:dns/promises': { default: {} },
        './config.js': { getCacheDir: () => '/fixture' },
        './proxy.js': { ensureProxyScheme: (s: string) => s, isSocksProxy: () => false, reconstructHttpUrl: () => '', reconstructSocksUrl: () => '' },
        'mmdb-lib': { Reader: class { get() { return { country: { iso_code: country }, location: { time_zone: timezone } }; } } },
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
    return module.namespace as unknown as { maybeResolveGeoip(options: any): Promise<any> };
}

describe('locked CloakBrowser GeoIP patch', () => {
    it('resolves the observed Mali exit without changing its timezone', async () => {
        const sdk = await geoipFixture('ML', 'Africa/Bamako');
        expect(await sdk.maybeResolveGeoip({ geoip: true })).toMatchObject({ timezone: 'Africa/Bamako', locale: 'fr-ML' });
        expect(Intl.DateTimeFormat.supportedLocalesOf(['fr-ML'])).toEqual(['fr-ML']);
    });
    it('retains existing Brazil mapping', async () => {
        const sdk = await geoipFixture('BR', 'America/Bahia');
        expect(await sdk.maybeResolveGeoip({ geoip: true })).toMatchObject({ timezone: 'America/Bahia', locale: 'pt-BR' });
    });
    it('fails explicitly for unmapped countries and preserves caller overrides', async () => {
        const sdk = await geoipFixture('ZZ', 'Etc/UTC');
        await expect(sdk.maybeResolveGeoip({ geoip: true })).rejects.toMatchObject({
            code: 'CLOAK_GEOIP_METADATA_MISSING', countryCode: 'ZZ', missing: ['locale'],
        });
        expect(await sdk.maybeResolveGeoip({ geoip: true, locale: 'de-DE' })).toMatchObject({ timezone: 'Etc/UTC', locale: 'de-DE' });
    });
    it('does not hide a missing timezone', async () => {
        const sdk = await geoipFixture('ML', null);
        await expect(sdk.maybeResolveGeoip({ geoip: true })).rejects.toMatchObject({ code: 'CLOAK_GEOIP_METADATA_MISSING', missing: ['timezone'] });
    });
});
