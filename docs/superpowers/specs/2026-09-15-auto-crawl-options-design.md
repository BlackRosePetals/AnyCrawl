# Approved auto-crawl options repair

The production API schema writes normalized crawl controls to `payload.options` and page options to `options.scrape_options`. The coordinator must consume this contract, including schema defaults, rather than silently falling back to ten pages.

Keep the coordinator as the only owner of global limit, depth and link selection. Child jobs retain their crawl type and metadata for existing Dataset and scrape-path behavior, but receive a one-page limit so Workers cannot independently fan out. Pass the nested page proxy, formats (plus internal links) and timeout correctly. Respect the existing same-hostname strategy without changing same-domain semantics.

Regression tests use the real crawl schema and a deterministic page graph with mocked queue/database I/O. Cover limits 1/2, schema defaults, depth, include/exclude and origin/hostname filtering, nested page options, metadata preservation and terminal statistics. Demonstrate failures before the fix, then rerun tests and builds.

Publish dev → PR → main. Only the API invokes this coordinator, so deploy the API only. Re-run bounded production crawls with limit 1/2 and filtering. Do not change schema, billing, search, Worker code or unrelated crawl lifecycle behavior.
