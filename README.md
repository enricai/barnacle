# Barnacle

Site-agnostic browser automation engine. Callers POST a structured payload to a
typed HTTP endpoint; Barnacle drives a Steel + Stagehand browser session through
the target site and returns a structured result. Each supported site is a
self-contained plugin — core handles sessions, retries, error mapping, audit
persistence, and response envelope wrapping.

## Endpoints

Each registered plugin exposes a POST route. The FEMA disaster assistance plugin
uses its legacy path for backward compatibility:

```
POST /v1/fema/submit
Authorization: Bearer <key>
Content-Type: application/json
```

New plugins follow the default convention: `POST /v1/<siteId>/run`.

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
├── server.ts                  # Fastify bootstrap — calls registerRoutes(), site-agnostic
├── site-plugin.ts             # SitePlugin<TInput,TOutput> interface (engine contract)
├── config.ts                  # frozen env-typed config singleton
├── plugins/
│   └── loader.ts              # SITE_PLUGINS registry, dispatch(), registerRoutes()
├── sites/
│   └── fema/                  # FEMA disaster assistance plugin (reference implementation)
│       ├── index.ts           # femaPlugin export: meta + execute()
│       ├── schema.ts          # Zod schemas for request + response
│       ├── service.ts         # execute() implementation
│       └── flow.ts            # Steel + Stagehand 42-page form automation
├── api/
│   ├── plugins/               # auth, error-handler, request-context
│   ├── routes/                # health
│   ├── schemas/               # common envelope schemas
│   ├── helpers/envelope.ts    # success envelope builder
│   └── errors.ts              # error hierarchy + envelope builder
├── scraper/
│   ├── session.ts             # Steel + Stagehand session factory
│   ├── pool.ts                # p-queue over createBrowserSession
│   ├── throttle.ts            # Bottleneck limiter + jitter
│   ├── retry.ts               # p-retry + failure classification
│   └── errors.ts              # typed scraper error hierarchy
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

## Plugin Authoring Guide

A site plugin is a single TypeScript module that satisfies `SitePlugin<TInput, TOutput>`
from `src/site-plugin.ts`. Core's loader discovers it through the static `SITE_PLUGINS`
array in `src/plugins/loader.ts` — no filesystem scanning, no dynamic imports.

### The SitePlugin interface

```ts
interface SitePlugin<TPayload, TResult> {
  meta: SitePluginMeta;
  execute(
    payload: TPayload,
    session: BrowserSession,
    context: SitePluginContext
  ): Promise<SitePluginResult<TResult>>;
  onRetry?: (error: ScraperError, attempt: number) => void;
}
```

### SitePluginMeta — required fields

| Field | Type | Purpose |
|---|---|---|
| `siteId` | `string` | Stable key used for routing (`/v1/<siteId>/run`) and audit rows |
| `displayName` | `string` | Human-readable label for logs and Swagger docs |
| `bodySchema` | `ZodTypeAny` | Request body schema — core validates before calling `execute()` |
| `responseSchema` | `ZodTypeAny` | Success response schema — drives Swagger output shape |
| `routeOverride?` | `string` | Override the full route path (legacy compatibility only) |
| `defaultBaseUrl?` | `string` | Fallback base URL when `config.scraper.siteBaseUrls[siteId]` is absent |

### Minimal plugin skeleton

```ts
// src/sites/example/index.ts
import { z } from "zod";
import { getEnv } from "@/lib/env";
import type { SitePlugin } from "@/site-plugin";

const requestSchema = z.object({ targetUrl: z.string().url() });
const responseSchema = z.object({ title: z.string() });

type ExampleRequest = z.infer<typeof requestSchema>;
type ExampleResult = z.infer<typeof responseSchema>;

export const examplePlugin: SitePlugin<ExampleRequest, ExampleResult> = {
  meta: {
    siteId: "example",
    displayName: "Example Site",
    bodySchema: requestSchema,
    responseSchema,
    defaultBaseUrl: getEnv("EXAMPLE_BASE_URL", "https://example.com"),
  },
  async execute(payload, session, context) {
    // context.baseUrl — resolved base URL (config map → defaultBaseUrl)
    // context.logger  — request-scoped Pino logger
    // context.config  — full AppConfig for cross-cutting settings
    await session.page.goto(`${context.baseUrl}${payload.targetUrl}`);
    const title = await session.page.title();
    return { data: { title } };
  },
};
```

### Register the plugin

Add one line to the `SITE_PLUGINS` array in `src/plugins/loader.ts`:

```ts
import { examplePlugin as loadedExamplePlugin } from "@/sites/example/index";

export const SITE_PLUGINS: SitePlugin<unknown, unknown>[] = [
  loadedPlugin as unknown as SitePlugin<unknown, unknown>,
  loadedExamplePlugin as unknown as SitePlugin<unknown, unknown>,
];
```

Use an import alias that doesn't repeat the siteId as a substring — this keeps
the `grep -v sites/<id>` lint check clean for the usage line.

Core registers the route `POST /v1/example/run` automatically at startup. No
changes to `server.ts`, `config.ts`, or any other core file are required.

## Reference

- FEMA form flow: [fema.md](./fema.md)
- Coding standards: [CLAUDE.md](./CLAUDE.md)
