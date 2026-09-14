# CloakBrowser 0.5.10 patch

`cloakbrowser@0.5.10.patch` is applied by pnpm through `pnpm-workspace.yaml` and
the lockfile. It does not update Chromium or disable GeoIP.

- Add the explicit `ML -> fr-ML` locale policy. GeoIP still supplies the exit's
  timezone. This is a browser locale choice, not an inference of a user's language.
- Preserve the resolved country code on missing-metadata errors and attach
  `CLOAK_GEOIP_METADATA_MISSING` plus the missing field names.
- Unknown countries and absent timezones remain errors. Explicit caller locale
  and timezone retain their SDK precedence.

The application catches Crawlee's fatal launch wrapper at the request boundary,
logs a bounded/redacted cause chain, and fails only that request. Metadata launch
retries require the caller's existing `retry: true` option and have a three-attempt
limit; other startup failures are not silently treated as proxy-rotation requests.

Regression: `packages/scrape/src/__tests__/core/CloakBrowserGeoip.test.ts` executes
the installed SDK source with deterministic I/O fixtures for ML, BR, unknown
countries, missing timezone, and explicit locale. The real Crawlee loop regression
is `packages/scrape/src/__tests__/engines/BrowserLaunchIsolation.test.ts`.

Upstream reviewed: https://github.com/CloakHQ/CloakBrowser/blob/main/js/src/geoip.ts
and https://github.com/CloakHQ/CloakBrowser/blob/main/README.md . Do not remove the
patch during an SDK upgrade until the same regressions pass against that release.
