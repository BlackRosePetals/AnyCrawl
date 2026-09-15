# Approved auto-crawl options repair

The production API schema writes normalized crawl controls to `payload.options` and page options to `options.scrape_options`. The coordinator must consume this contract, including schema defaults, rather than silently falling back to ten pages.

Keep the coordinator as the only owner of global limit, depth and link selection. Child jobs use scrape queues and explicitly use the scrape type. Those Workers force the scrape type and consume flat options, so flatten normalized page proxy/formats/timeout while retaining existing crawl metadata and template ID. Only the coordinator follows links. A first nested-options attempt was rolled back after the production content assertion failed; the regression now checks the real flat Worker contract. Respect the existing same-hostname strategy without changing same-domain semantics.

Regression tests use the real crawl schema and a deterministic page graph with mocked queue/database I/O. Cover limits 1/2, schema defaults, depth, include/exclude and origin/hostname filtering, nested page options, metadata preservation and terminal statistics. Demonstrate failures before the fix, then rerun tests and builds.

Publish dev → PR → main. Only the API invokes this coordinator, so deploy the API only. Re-run bounded production crawls with limit 1/2 and filtering. Do not change schema, billing, search, Worker code or unrelated crawl lifecycle behavior.
