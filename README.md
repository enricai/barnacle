# Barnacle

Headless Node.js / TypeScript API that automates FEMA disaster assistance
application submissions on behalf of disaster survivors.

A caller POSTs a fully structured application payload (applicant info, needs,
identity, bank account, etc.) and Barnacle drives a Steel + Stagehand browser
session through all 42 pages of DisasterAssistance.gov, returning the FEMA
confirmation number on success.

## Endpoint

```
POST /v1/fema/submit
Authorization: Bearer <key>
Content-Type: application/json
```

Request body: see `src/api/schemas/fema-submission.ts` for the full Zod schema
covering all five form phases (pre-application, needs assessment, identity,
application center, review/submit).

Operational routes:
- `GET /healthz` — liveness probe
- `GET /readyz`  — readiness probe (checks DB, scraper credentials, queue depth)
- `GET /docs`    — Swagger UI (when `ENABLE_DOCS=true`)

## Getting started

### Prerequisites

- Node.js 22+
- pnpm 10.4.1
- PostgreSQL (for submission history; optional — server starts without it)
- A Steel account (`STEEL_API_KEY`) for managed browser sessions
- An Anthropic key (`ANTHROPIC_API_KEY`) for Stagehand's LLM calls, **or** AWS Bedrock (`USE_BEDROCK=true` + AWS credentials) — see `.env.example` for details

### Install

```bash
pnpm install
cp .env.example .env   # fill in STEEL_API_KEY and either ANTHROPIC_API_KEY or Bedrock creds
pnpm run db:push       # create tables
```

### Dev

```bash
FEMA_BASE_URL=http://localhost:8020 pnpm run dev
# Point at the mock site for development; omit to hit DisasterAssistance.gov
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
| `pnpm run db:push` / `db:studio` / `db:generate` | Prisma |

## Architecture

```
src/
├── server.ts                  # Fastify bootstrap + plugin registration
├── config.ts                  # frozen env-typed config singleton
├── api/
│   ├── plugins/               # auth, error-handler, request-context
│   ├── routes/                # fema-submission, health
│   ├── schemas/               # Zod schemas (fema-submission, common envelope)
│   ├── helpers/envelope.ts    # success envelope builder
│   └── errors.ts              # error hierarchy + envelope builder
├── scraper/
│   ├── session.ts             # Steel + Stagehand session factory
│   ├── pool.ts                # p-queue over createBrowserSession
│   ├── throttle.ts            # Bottleneck limiter + jitter
│   ├── retry.ts               # p-retry + failure classification
│   ├── errors.ts              # typed scraper error hierarchy
│   └── flows/
│       └── fema-submission.ts # 42-page FEMA form automation
├── services/
│   └── fema-submission.ts     # orchestration: pool → flow → Prisma → envelope
├── cache/response-cache.ts    # lru-cache wrapper
├── lib/                       # logging, env, db client
└── types/
```

**Library choices** (battle-tested — no custom reinventions):

- API server: [`fastify`](https://fastify.dev/) + helmet + compress + rate-limit + swagger
- Schema: [`zod`](https://zod.dev/) via `fastify-type-provider-zod`
- Browser automation: [`@browserbasehq/stagehand`](https://github.com/browserbase/stagehand) + [`steel-sdk`](https://steel.dev)
- Concurrency: [`p-queue`](https://github.com/sindresorhus/p-queue), [`p-retry`](https://github.com/sindresorhus/p-retry), [`bottleneck`](https://github.com/SGrondin/bottleneck)
- Caching: [`lru-cache`](https://github.com/isaacs/node-lru-cache)
- Logging: [`pino`](https://github.com/pinojs/pino) with CloudWatch 256KB splitting + sensitive-field redaction

## Reference

- FEMA form flow: [fema.md](./fema.md)
- Coding standards: [CLAUDE.md](./CLAUDE.md)
