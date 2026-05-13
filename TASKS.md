# RC Cruise Scraper API — Task Breakdown

**Status: complete.** The original scope has been expanded to feature parity
with the Royal Caribbean VPS API (8 endpoints) rather than a single
`POST /search`. See `./RC_API_Docs/` for the source docs and `README.md`
for the current architecture.

## Phase 1 — Environment & Infrastructure Setup

### ✅ Task 1: Initialize the project repo
Converted the Next.js template to a Node.js/TypeScript backend with
Fastify, Zod, dotenv, Steel SDK, Stagehand. Commits: `2f3ee16`,
`0af302d`, `f733c71`.

### ✅ Task 2: Spin up Steel browser session
`src/scraper/session.ts` — creates a Steel cloud session with residential
proxies (`useProxy: true`) and wires Stagehand over the Steel websocket
URL. Teardown is guaranteed via the `close()` method. Commit: `36873cd`.

## Phase 2 — RC Site Exploration & Schema Design

### ⚠️ Task 3: Manual reconnaissance of the RC search flow
**Human task** — the `src/scraper/flows/*.ts` files use generic Stagehand
prompts that should be refined against the live DOM. Contract is locked in;
prompt text is the moving part.

### ✅ Task 4: Define the output Zod schema
All 8 VPS response schemas live under `src/api/schemas/`, each with a
round-trip test against the matching RC sample JSON in `RC_API_Docs/`.
Commits: `a7f4ddd`, `d537dec`, `3d611d1`.

## Phase 3 — Automation Script

### ✅ Task 5: Build the search filter interaction script
`src/scraper/flows/sailing-package.ts` + `pricing.ts` + `promotions.ts` —
each uses `page.act()` for discrete filter interactions, wrapped in the
`bottleneck` session limiter so throttling + jitter happen automatically.
Commit: `090eab3`.

### ✅ Task 6: Build the results extraction script
Same files — `page.extract({ schema })` pulls typed data from the results
pages. Empty results throw `EmptyResultsError` (which our retry policy
aborts on rather than retrying). Commit: `090eab3`.

### ✅ Task 7: Implement Stagehand caching
`enableCaching: true` in the Stagehand constructor (`src/scraper/session.ts`).
When a cached action fails, the outer `p-retry` loop triggers a fresh
AI-resolution attempt automatically. Commit: `36873cd`.

## Phase 4 — API Wrapper

### ✅ Task 8: Build the HTTP API layer
Fastify server with `@fastify/helmet`, `@fastify/compress`,
`@fastify/rate-limit`, `@fastify/swagger`, request-context hook, auth
plugin, error handler, and 8 VPS-parity routes. Commit: `80fe869`,
`090eab3`.

### ✅ Task 9: Add concurrency and session pooling
`src/scraper/pool.ts` — `p-queue` with `concurrency=SESSION_POOL_SIZE`
(default 3). Sessions created on-demand inside each queued task, closed
in a `finally` block. Commit: `36873cd`.

### ✅ Task 10: Error handling and retry logic
`src/scraper/retry.ts` — wraps `p-retry`. CaptchaError + EmptyResultsError
abort without retrying; SessionTimeoutError restarts the session and
retries once; SelectorFailureError retries up to maxAttempts with
exponential backoff. All surfaced through the VPS error envelope.
Commit: `36873cd`.

## Phase 5 — Hardening

### ✅ Task 11: Rate limiting and request throttling
Outbound: `bottleneck` limiter per scraper session with randomized 500–
1500 ms min-time + jitter (`src/scraper/throttle.ts`). Inbound: 
`@fastify/rate-limit` keyed by Authorization header with IP fallback,
emits the VPS envelope with code 1010 THROTTLED_REQUEST on hits.
`randomViewport()` picks from a desktop pool each session. Commits:
`36873cd`, `80fe869`.

### ✅ Task 12: Monitoring and change detection
`src/workers/refresh.ts` (daily full refresh) + `src/workers/changes.ts`
(hourly trickle) via `croner`. `src/scripts/smoke-test.ts` runs one fixed
sailing-package query and asserts the Zod schema parses the response —
ready to wire into a GitHub Actions cron. Snapshot history in
`PricingSnapshot` / `SailingSnapshot` / `PromotionSnapshot` Prisma models
powers the three delta endpoints. Commit: `dc16804`.

## Beyond original scope — VPS parity

Barnacle now mirrors Royal Caribbean's full VPS API surface:

1. `GET  /v1/catalog/sailing-package`
2. `POST /v1/catalog/sailing-package-changes`
3. `POST /v1/partner-pricing/super-category-pricing`
4. `POST /v1/partner-pricing/category-pricing`
5. `POST /v1/partner-pricing/group-pricing`
6. `POST /v1/pricing-snapshot/price-changes/super-category`
7. `POST /v1/pricing-snapshot/price-changes/category`
8. `POST /v1/promotion/promotion-details`

Plus operational routes (`/healthz`, `/readyz`, `/docs` when
`ENABLE_DOCS=true`) and auto-derived OpenAPI 3.1 at `/v1/openapi.json`.

## Test coverage

80+ tests across 17 files — schemas round-trip the RC sample JSON,
services verify end-to-end VPS envelope shapes with the scraper mocked,
route-level integration tests cover auth + validation, scraper retry +
pool + throttle have full unit coverage, error envelope + config
loader + cache are all exercised.
