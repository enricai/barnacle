# Barnacle

Headless Node.js / TypeScript API that mirrors Royal Caribbean's **VPS
(Vendor Pricing Services) API surface** from public data sources.

A VPS client can point at Barnacle and see the same 8 operations, the
same JSON request bodies, and the same response envelopes they'd get
from `api.rccl.com`. The difference is that Barnacle doesn't need an
official AppKey — it sources everything from `royalcaribbean.com`'s
public endpoints and shapes the results into VPS's contract.

## Two data paths

- **Hot path — direct HTTP.** RC's public GraphQL endpoints
  (`/cruises/graph`, `/graph`) are unauthenticated and return the full
  catalog with per-stateroom-class pricing inline. Zero browser, zero
  Steel session, sub-second per request. Powers `sailing-package`,
  `super-category-pricing`, and `promotion-details`.
- **Fallback — Stagehand + Steel.** When a sailing isn't in the
  GraphQL catalog response (cancelled sailings, pending launches) or
  the GraphQL endpoint drifts, the service layer falls back to a
  browser-driven scrape. Category and group pricing always use this
  path because they need per-category detail the catalog doesn't
  expose.

Recon of the GraphQL contract lives in `docs/rc-recon.md`.

## Feature surface

All 8 VPS endpoints, re-hosted under `/v1/`:

| VPS operation | Barnacle route |
|---------------|----------------|
| Sailing Package | `GET  /v1/catalog/sailing-package` |
| Sailing Package Changes | `POST /v1/catalog/sailing-package-changes` |
| Super Category Pricing | `POST /v1/partner-pricing/super-category-pricing` |
| Category Pricing | `POST /v1/partner-pricing/category-pricing` |
| Group Pricing | `POST /v1/partner-pricing/group-pricing` |
| Price Changes — Super Category | `POST /v1/pricing-snapshot/price-changes/super-category` |
| Price Changes — Category | `POST /v1/pricing-snapshot/price-changes/category` |
| Promotion Details | `POST /v1/promotion/promotion-details` |

Plus a JSON-body search route that wraps the sailing-package service:

- `POST /v1/search` — native JSON body with the full TASKS.md Task 8
  filter set (the query-string route expects comma-separated strings for
  RC parity; this is the modern equivalent). Supported fields:
  - `brandCode` (default `"R"`), `fromSailDate`, `toSailDate` (required)
  - `shipCodes: string[]`, `destinations: string[]` (e.g. `CARIB`,
    `BAHAM`), `departurePorts: string[]` (e.g. `MIA`, `FLL`)
  - `cruiseLengthRange: { min, max }` (1..30 / 1..60 nights)
  - `guestCount: 1..8`, `cabinType: "INTERIOR"|"OUTSIDE"|"BALCONY"|"SUITE"`
  - `includeTourPackages: boolean`

Plus operational routes:

- `GET  /healthz` — liveness probe
- `GET  /readyz`  — readiness probe
- `GET  /docs`    — Swagger UI (when `ENABLE_DOCS=true`)

## Modern hardening over VPS

Barnacle keeps VPS's request/response contract but improves the
security/ops posture:

- `Authorization: Bearer <key>` with bcrypt-hashed keys at rest (VPS
  uses a single opaque `X-API-key` header).
- Formally documented rate limiting with `Retry-After` +
  `X-RateLimit-*` headers (VPS has it but doesn't document it).
- Request IDs echoed back as `X-Request-ID`; correlation IDs
  propagated via `X-Correlation-ID` for distributed tracing.
- OpenAPI 3.1 auto-derived from Zod schemas at `/docs` and
  `/v1/openapi.json`.
- Security headers via `@fastify/helmet`.
- gzip/br compression via `@fastify/compress` — matches VPS's
  `Accept-Encoding: gzip` expectation.
- Problem+JSON (RFC 7807) planned for `Accept: application/problem+json`.

## Getting started

### Prerequisites

- Node.js 22+
- pnpm 10.4.1
- PostgreSQL (for snapshot history; the server starts without a DB but
  the delta endpoints and the daily refresh worker won't function).

Only for the Stagehand fallback path (category/group pricing + any
sailing not in the GraphQL catalog):

- A Steel account (`STEEL_API_KEY`) — residential proxies recommended
  in production; free tier works for the hot path alone.
- An Anthropic key (`ANTHROPIC_API_KEY`) for Stagehand's LLM calls.

The `smoke` script, `sailing-package`, and `super-category-pricing` run
without these keys.

### Install

```bash
pnpm install
cp .env.example .env   # fill in real values
pnpm run db:push       # create tables
```

### Dev

```bash
pnpm run dev           # tsx watch src/server.ts
```

### Smoke test

Runs one live `sailing-package` request against RC's GraphQL endpoint
and parses it through the Zod schema. Exits non-zero on schema drift
or on a zero-sailings response — wire it to a GitHub Actions cron as
a deploy-gate signal. No Steel/Anthropic keys required.

```bash
pnpm run smoke
```

### Generate OpenAPI JSON

```bash
ENABLE_DOCS=true pnpm run openapi:generate
# writes openapi.json
```

### Build for production

```bash
pnpm run build
pnpm start
```

## Commands

| Command | What it does |
|---------|--------------|
| `pnpm run dev` | `tsx watch src/server.ts` with hot reload |
| `pnpm run build` | emit `dist/` via `tsc` |
| `pnpm start` | `node dist/server.js` |
| `pnpm run typecheck` | strict TS noEmit |
| `pnpm run lint` / `lint:fix` | Biome |
| `pnpm run test` | Vitest unit + integration |
| `pnpm run smoke` | live smoke test via direct-HTTP GraphQL |
| `pnpm run openapi:generate` | write `openapi.json` |
| `pnpm run db:push` / `db:studio` / `db:generate` | Prisma |

## Architecture

```
src/
├── server.ts                  # Fastify bootstrap + plugin registration
├── config.ts                  # frozen env-typed config singleton
├── api/
│   ├── plugins/               # auth, error-handler, request-context
│   ├── routes/                # one file per VPS endpoint
│   ├── schemas/               # Zod schemas driving validation + OpenAPI
│   ├── helpers/envelope.ts    # VPS success envelope
│   └── errors.ts              # VpsError hierarchy + envelope builder
├── scraper/
│   ├── graphql.ts             # direct-HTTP GraphQL client (hot path)
│   ├── sitemap.ts             # browser-free itinerary discovery
│   ├── session.ts             # Steel + Stagehand factory (fallback)
│   ├── pool.ts                # p-queue over createBrowserSession
│   ├── throttle.ts            # bottleneck limiter + jitter
│   ├── retry.ts               # p-retry + failure classification
│   ├── errors.ts              # typed scraper error hierarchy
│   └── flows/                 # graphql-catalog + graphql-pricing hot paths,
│                              # sailing-package + pricing Stagehand fallbacks
├── services/                  # endpoint orchestration
├── cache/response-cache.ts    # lru-cache wrapper
├── snapshots/store.ts         # Prisma-backed snapshot storage
├── workers/                   # croner refresh + changes jobs
├── scripts/                   # smoke-test, generate-openapi, recon-*
├── lib/                       # logging, env, db, api helpers
└── types/
```

**Library choices** (battle-tested — no custom reinventions):

- API server: [`fastify`](https://fastify.dev/) + helmet + compress + rate-limit + swagger + swagger-ui
- Schema: [`zod`](https://zod.dev/) via `fastify-type-provider-zod`
- Scraper fallback: [`@browserbasehq/stagehand`](https://github.com/browserbase/stagehand) + [`steel-sdk`](https://steel.dev)
- Concurrency: [`p-queue`](https://github.com/sindresorhus/p-queue) (session pool), [`p-retry`](https://github.com/sindresorhus/p-retry) (retries), [`bottleneck`](https://github.com/SGrondin/bottleneck) (throttling)
- Caching: [`lru-cache`](https://github.com/isaacs/node-lru-cache)
- Cron: [`croner`](https://github.com/hexagon/croner)
- Logging: [`pino`](https://github.com/pinojs/pino) with CloudWatch 256KB splitting + sensitive-field redaction

## Reference

- RC VPS docs: `./RC_API_Docs/` (VPS Onboarding Spec v1.9 + 8 sample JSON files)
- Coding standards: [CLAUDE.md](./CLAUDE.md)
