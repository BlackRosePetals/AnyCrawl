# CloakBrowser 0.5.10 patch

`cloakbrowser@0.5.10.patch` is applied by pnpm through `pnpm-workspace.yaml` and
the lockfile. It does not update Chromium or disable GeoIP.

- Add the explicit `ML -> fr-ML` locale policy. GeoIP still supplies the exit's
  timezone. This is a browser locale choice, not an inference of a user's language.
- After successfully resolving the proxy exit IP, fill only missing metadata:
  timezone defaults to `UTC`, locale to `en-US`. Existing GeoIP values and explicit
  caller options/raw flags retain their precedence. No new API option is needed.
- Reuse that same exit IP for WebRTC; no second lookup, proxy change, or direct
  connection is introduced to supply metadata defaults.
- Emit one structured `geoip_metadata_defaulted` warning per degraded resolution,
  with missing fields, country code if available, selected defaults, and a
  process-local cumulative count. Never log the proxy URL, credentials, or exit IP.
- IP echo failures and unreadable/corrupt GeoIP databases still fail. A proxy
  gateway DNS/literal address is no longer substituted for an unobserved exit IP;
  this prevents transport failure from being accepted as missing geographic data.

The application catches Crawlee's fatal launch wrapper at the request boundary,
logs a bounded/redacted cause chain, and fails only that request. Metadata launch
retries require the caller's existing `retry: true` option and have a three-attempt
limit; this legacy metadata error handling remains compatible with older SDK
errors, but missing metadata now defaults before reaching that boundary. Other
startup failures are not silently treated as proxy-rotation requests.

Regression: `packages/scrape/src/__tests__/core/CloakBrowserGeoip.test.ts` executes
the installed SDK source with deterministic I/O fixtures for ML, BR, unknown
countries, absent MMDB records, missing timezone, explicit options/raw flags,
transport/authentication failures, and database errors. The real Crawlee loop regression
is `packages/scrape/src/__tests__/engines/BrowserLaunchIsolation.test.ts`.

Upstream reviewed: https://github.com/CloakHQ/CloakBrowser/blob/main/js/src/geoip.ts
and https://github.com/CloakHQ/CloakBrowser/blob/main/README.md . Do not remove the
patch during an SDK upgrade until the same regressions pass against that release.
