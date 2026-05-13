# Barnacle

Headless Node.js / TypeScript API that mirrors Royal Caribbean's **VPS
(Vendor Pricing Services) API surface**, powered by a Stagehand + Steel
browser-automation scraper.

A VPS client can point at Barnacle and see the same 8 operations, the
same JSON request bodies, and the same response envelopes they'd get
from `api.rccl.com`. The difference is that Barnacle doesn't need an
official AppKey — it drives the public `royalcaribbean.com` site with
Stagehand and shapes the results into VPS's contract.

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
- PostgreSQL (for snapshot history)
- A Steel account (`STEEL_API_KEY`) — residential proxies enabled
- An Anthropic key (`ANTHROPIC_API_KEY`) for Stagehand's LLM calls

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

Run one live `sailing-package` request end to end and parse it through
the Zod schema. Exits non-zero on schema drift — wire it to a GitHub
Actions cron for Task 12.

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
| `pnpm run smoke` | live smoke test against the scraper |
| `pnpm run openapi:generate` | write `openapi.json` |
| `pnpm run db:push` / `db:migrate` / `db:studio` | Prisma |

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
│   ├── session.ts             # Steel + Stagehand factory
│   ├── pool.ts                # p-queue over createBrowserSession
│   ├── throttle.ts            # bottleneck limiter + jitter
│   ├── retry.ts               # p-retry + failure classification
│   ├── errors.ts              # typed scraper error hierarchy
│   └── flows/                 # site-specific scrape recipes
├── services/                  # endpoint orchestration
├── cache/response-cache.ts    # lru-cache wrapper
├── snapshots/store.ts         # Prisma-backed snapshot storage
├── workers/                   # croner refresh + changes jobs
├── scripts/                   # smoke-test, generate-openapi
├── lib/                       # logging, env, db, api helpers
└── types/
```

**Library choices** (battle-tested — no custom reinventions):

- API server: [`fastify`](https://fastify.dev/) + helmet + compress + rate-limit + swagger + swagger-ui
- Schema: [`zod`](https://zod.dev/) via `fastify-type-provider-zod`
- Scraper: [`@browserbasehq/stagehand`](https://github.com/browserbase/stagehand) + [`steel-sdk`](https://steel.dev)
- Concurrency: [`p-queue`](https://github.com/sindresorhus/p-queue) (session pool), [`p-retry`](https://github.com/sindresorhus/p-retry) (retries), [`bottleneck`](https://github.com/SGrondin/bottleneck) (throttling)
- Caching: [`lru-cache`](https://github.com/isaacs/node-lru-cache)
- Cron: [`croner`](https://github.com/hexagon/croner)
- Logging: [`pino`](https://github.com/pinojs/pino) with CloudWatch 256KB splitting + sensitive-field redaction

## Reference

- RC VPS docs: `./RC_API_Docs/` (VPS Onboarding Spec v1.9 + 8 sample JSON files)
- Coding standards: [CLAUDE.md](./CLAUDE.md)
