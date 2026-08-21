# Barnacle

Point Barnacle at a site, describe the user flow in plain English, and run three
recon commands. Barnacle drives a real browser through the flow, captures every
API call, replays them with plain HTTP to prove which ones work without a browser,
probes rate-limit ceilings, and then generates a complete plugin — Zod schemas
inferred from captured JSON, load-bearing headers, rate-limit ceiling, hot-path
HTTP client, and Stagehand browser fallback. Register the plugin in one line;
Barnacle handles sessions, retries, fallback routing, audit persistence, and
response envelope wrapping.

## How it works

Stagehand drives a real browser through your described user flow. Its only job is
to trigger the site's network traffic — not to extract DOM data. While it clicks,
a response listener wiretaps every API call to disk. Once that recon run is done,
a separate script replays those captures via plain `fetch()` — no browser, no AI —
to prove the endpoints work standalone. The surviving queries and headers become
committed constants. In production, the runtime hits those endpoints directly:
fast, cheap, deterministic. The browser only re-engages if the direct path breaks.

A nightly smoke test tells you the moment a contract drifts. When it fires, you
re-run the same recon command you ran the first time and diff the captures.
Human involvement is one recon run up front and a small PR when things change.

| Phase | What runs | What you get |
|-------|-----------|--------------|
| **1 — Browser recon** | `pnpm run recon:browser` | Every API call the site makes, captured to `<run-dir>/graphql/*.json` |
| **2–3 — HTTP replay + probing** | `pnpm run recon:http` | Proof each endpoint works without a browser; rate-limit ceiling; static fixtures |
| **4 — Plugin generation** | `pnpm run recon:generate` | A complete plugin: Zod schemas, headers, Bottleneck config, hot-path client, Stagehand fallback |
| **5+ — Runtime** | `pnpm start` | Direct HTTP hot path, automatic browser fallback, nightly smoke test, drift detection |

See [docs/architecture.md](./docs/architecture.md) for the full design rationale,
including why this beats browser-on-every-request, HTML scraping, manual DevTools
recon, and HAR replay.

## Adding a New Site — The Recon Playbook

Every new site follows the same pipeline (Phases 0–6). The only human-authored
input is the flow definition you write once in Phase 0. After that, the scripts
run unattended — recon captures, HTTP replay proves endpoints, the generator
writes the plugin. When the site changes months later, you re-run the same
command and diff the captures. Human time is front-loaded to one recon run and
a small PR.

The full step-by-step playbook lives in [docs/playbook.md](./docs/playbook.md):

- [Phase 0 — Define the user flow](./docs/playbook.md#phase-0--define-the-user-flow)
- [Phase 1 — Browser recon](./docs/playbook.md#phase-1--browser-recon-recon-browserts) — `pnpm run recon:browser`, self-healing cascade, cookie-jar snapshots
- [Phase 2 — HTTP replay](./docs/playbook.md#phase-2--http-replay-recon-httpts) — `pnpm run recon:http`
- [Phase 3 — Edge probing](./docs/playbook.md#phase-3--edge-probing-recon-httpts-still-automated) — GraphQL introspection, fixture detection, rate-limit probe
- [Phase 4 — Codify the contract](./docs/playbook.md#phase-4--codify-the-contract-one-human-pr) — `pnpm run recon:generate`, `--vocabulary`, `--form-schema`
- [Phase 5 — Runtime: hot path + fallback](./docs/playbook.md#phase-5--runtime-hot-path--fallback)
- [Phase 6 — Drift detection](./docs/playbook.md#phase-6--drift-detection) — nightly smoke test, maintenance loop

### The whole loop, in one picture

![Barnacle end-to-end workflow: Setup (recon) feeds a dashed Deploys edge into Runtime (dispatch + cache + hot path), Heal catches errors and runs nightly drift detection, and a solid orange arrow sweeps back from smoke-test.ts into Phase 1 to close the self-healing loop.](docs/images/workflow.svg)

The dashed `deploys` edge is the human-in-the-loop step (the contract PR merges and ships to Runtime). The solid orange edge from `smoke-test.ts` back into Phase 1 is the self-healing loop: when the contract drifts, recon reruns unattended (~20–40 min) and the next PR is a diff of captures, not a hand-rewrite. See [docs/architecture.md](./docs/architecture.md) for the design rationale behind each lane.

## Writing a plugin

A site plugin is a single TypeScript module that satisfies `SitePlugin<TInput, TOutput>`
from `src/site-plugin.ts` — a `meta` block, an optional `executeHttp` hot path, and a
Stagehand `execute` fallback. `pnpm run recon:generate` writes this structure for you;
most of the time you're reviewing and trimming, not authoring from scratch. Plugins can
also be config-only JSON manifests with no TypeScript at all.

Full interface reference, the plugin skeleton, reconciliation join keys, static
fixtures, and how to register a plugin (out-of-tree, config-only, or in-tree) live in
[docs/plugin-authoring.md](./docs/plugin-authoring.md).

## Usage

### Prerequisites

- Node.js 22+
- pnpm 10.4.1
- A Browserbase account (`BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID`) for managed browser sessions — the default provider. A Steel account (`STEEL_API_KEY`) is an alternative via `SCRAPER_PROVIDER=steel`
- An Anthropic key (`ANTHROPIC_API_KEY`) for Stagehand's LLM calls, **or** AWS Bedrock (`USE_BEDROCK=true` + AWS credentials) — see [docs/configuration.md](./docs/configuration.md) for details

### Install

```bash
pnpm install
cp .env.example .env   # fill in BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID (or STEEL_API_KEY for SCRAPER_PROVIDER=steel) and either ANTHROPIC_API_KEY or Bedrock creds
```

### Generating an API key

Barnacle validates every request using bcrypt-hashed bearer tokens stored in
`API_KEYS_HASHED`. To create one:

```bash
# 1. Generate a random plaintext key — save this, you'll send it as Authorization: Bearer <key>
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Hash it (bcrypt cost factor 10) — paste the output into API_KEYS_HASHED
node -e "const b=require('bcryptjs');b.hash(process.argv[1],10,(e,h)=>console.log(h))" <your-key>
```

Comma-separate multiple hashes in `API_KEYS_HASHED` to support key rotation.
For local development, set `DEV_BYPASS_AUTH=true` in `.env` to skip auth entirely
— never set this in production. Full env-var reference:
[docs/configuration.md](./docs/configuration.md).

### Dev

```bash
pnpm run dev
```

### Build for production

```bash
pnpm run build
pnpm start
```

### Try it

Barnacle boots with the built-in plugins registered (see `BUILTIN_SITE_PLUGINS` in `src/plugins/discover.ts`). Follow [Adding a New Site](#adding-a-new-site--the-recon-playbook) above to build and register a plugin; core will register `POST /v1/<your-siteId>/run` automatically at startup.

With the dev server running (`pnpm run dev`), confirm the server is up:

```bash
curl -s http://localhost:3000/health | jq .
```

Once a plugin is registered, every response follows the same envelope shape. The status block is always present; the plugin's `responseSchema` fields are spread alongside it at the root:

```json
{
  "status": {
    "httpStatus": "OK",
    "dateTime": "2025-05-16T12:00:00.000Z",
    "details": []
  },
  "items": []
}
```

The envelope is a **flat merge**, not nested — `status` lives at the root and the plugin's response fields are spread alongside it (`src/api/helpers/envelope.ts:8-25`). Parse as `{ status, ...pluginData }`, not `{ status, data: pluginData }`.

Every response — success or error — uses the same envelope shape so clients share a single parser. Error codes and their meanings live in `src/api/schemas/common.ts` (`ERROR_CODES`).

Each registered plugin exposes `POST /v1/<siteId>/run`, plus any extra routes it
declares via `meta.extraRoutes` (e.g. `/resume`, `/trigger-otp`). Operational routes:
`GET /healthz`, `GET /readyz`, `GET /docs` (Swagger, when `ENABLE_DOCS=true`),
`GET /v1/plugins`, and `GET /v1/submissions`. See
[docs/plugin-authoring.md#endpoints](./docs/plugin-authoring.md#endpoints) for the
full endpoint reference.

## Commands

| Command | What it does |
|---------|--------------|
| `pnpm run dev` | `tsx watch --env-file=.env src/server.ts` with hot reload |
| `pnpm run build` | compile to `dist/` (tsc + path alias rewriting + copy `src/sites/` fixtures and `src/testing/fixtures`) |
| `pnpm start` | `node dist/server.js` |
| `pnpm run typecheck` | strict TS noEmit |
| `pnpm run lint` / `lint:fix` | Biome |
| `pnpm run test` | Vitest unit + integration |
| `pnpm test src/scraper/fixtures.test.ts` | Run a single test file (NEVER use `--` before the filter) |
| `pnpm run test:watch` | Vitest in watch mode (re-runs on file changes) |
| `pnpm run test:coverage` | Vitest with v8 coverage report |
| `pnpm run format` | Biome format write |
| `pnpm run recon:browser` | Phase 1 — drive browser + capture API calls |
| `pnpm run recon:http` | Phases 2–3 — replay, introspect, probe rate limits |
| `pnpm run recon:generate -- --site-id <id>` | Phase 4 — generate complete plugin from artifacts |
| `pnpm run recon:summarize -- --site-id <id>` | Phase 4 (optional) — write human-readable findings doc |
| `pnpm run recon:heal -- --site-id <id> --url <url>` | Self-heal a failing recon flow without modifying the source file |
| `pnpm run smoke -- --site <id> --payload '...'` | Phase 6 — run nightly drift-detection smoke test |
| `pnpm run judge:llm -- --calls-ndjson <path> --call-type <type>` | Score captured LLM calls on a three-dimensional rubric; writes a verdict JSON to `judge-out/` |
| `pnpm run heal:llm -- --verdict-path <path> --call-type <type>` | Self-heal a failing prompt template: iterate patch→replay→score, write `healing-<callType>.md` with the best patch — production prompts are never modified |

## Architecture

```
src/
├── server.ts                  # Fastify bootstrap — calls loadAllPlugins(), registerRoutes(), site-agnostic
├── site-plugin.ts             # SitePlugin<TInput,TOutput> interface (engine contract)
├── config.ts                  # frozen env-typed config singleton
├── plugins/
│   ├── loader.ts              # dispatch(), registerRoutes(app, cfg, plugins)
│   └── discover.ts            # BUILTIN_SITE_PLUGINS, loadAllPlugins(), loadPlugins()
├── sites/
│   ├── _shared/               # branch-local cross-plugin guards (coverage-expectations.test.ts)
│   └── <site-id>/             # one directory per registered plugin
├── api/
│   ├── plugins/               # auth, error-handler, request-context
│   ├── routes/                # health
│   ├── schemas/               # common envelope schemas; LLM telemetry + judge-verdict schemas
│   ├── helpers/envelope.ts    # success envelope builder
│   └── errors.ts              # error hierarchy + envelope builder
├── scraper/
│   ├── session.ts             # Stagehand session factory (Browserbase default, Steel opt-in fallback)
│   ├── pool.ts                # p-queue over createBrowserSession
│   ├── throttle.ts            # Bottleneck limiter + jitter
│   ├── retry.ts               # p-retry + failure classification
│   ├── errors.ts              # typed scraper error hierarchy
│   ├── http-client.ts         # typed fetch wrapper (hot path)
│   ├── rate-limited-json-client.ts # factory: Bottleneck + chromiumClientHints + createHttpClient in one call — prefer this over the three-step scaffold for Chromium-hint plugins
│   ├── http-status-classifier.ts # pure status→ScraperError classifier for raw-fetch callers
│   ├── raw-fetch.ts           # site-agnostic undici scaffold: network-error wrap, onResponse hook, optional classifyHttpStatus (skipClassify for callers that classify manually)
│   ├── graphql-client.ts      # GraphQL POST wrapper
│   ├── metrics.ts             # drift-detection counters
│   ├── fixtures.ts            # static JSON fixture loader
│   ├── navigate.ts            # shared awaitActivePage + goto(networkidle) helper
│   ├── behavioral-signals.ts  # CDP synthetic mouse-move + scroll dispatcher for bot-detection warmup
│   ├── session-warmup.ts      # generic pRetry browser-session runner: acquire → callback → close, with caller-supplied exhaustion mapping
│   ├── session-ip.ts          # resolves a session's outbound IP via a throwaway tab + IP-echo navigation
│   └── require-response-field.ts # shared helpers for extracting required fields from HTTP response objects (HttpSchemaError on missing/null)
├── cache/
│   ├── response-cache.ts      # lru-cache wrapper for deduplicating concurrent identical scraper requests
│   └── keyed-ttl-cache.ts     # generic per-key TTL + single-flight coalescing cache factory
├── lib/                       # logging, env, bedrock, db client, multipart, option-matcher, chromium-client-hints, telemetry/
├── scripts/                   # recon-browser, recon-http, recon-generate, recon-summarize, recon-heal, recon-shared, smoke-test, judge-llm-batch, llm-heal
├── testing/
│   ├── integration-runner.ts              # site-agnostic scaffold for integration tests (allocate inbox → dispatch → poll)
│   ├── mock-fetch-response.ts             # shared undici-compatible Response stub factory for flow tests that mock fetch
│   ├── replay-integration-suite.ts        # generic describe.skipIf/it.each scaffold; eliminates per-site integration boilerplate
│   ├── contract-parity-suite.ts           # offline schema-parity scaffold; one-call drop-in for accept + rejection-case coverage
│   ├── coverage-guard-suite.ts            # registry-driven structural guard; asserts contract.parity.test.ts exists per registered plugin
│   ├── batch-email-confirmation.ts        # two-phase batch runner: submit jobs → poll inboxes (site-agnostic)
│   └── batch-report.ts                    # markdown table renderer for batch-test verdicts
└── types/
```

**Library choices** (battle-tested — no custom reinventions):

- API server: [`fastify`](https://fastify.dev/) + helmet + compress + rate-limit + swagger
- Schema: [`zod`](https://zod.dev/) via `fastify-type-provider-zod`
- Browser automation: [`@browserbasehq/stagehand`](https://github.com/browserbase/stagehand) with [`@browserbasehq/sdk`](https://browserbase.com) (default provider) and [`steel-sdk`](https://steel.dev) (opt-in fallback via `SCRAPER_PROVIDER=steel`)
- Concurrency: [`p-queue`](https://github.com/sindresorhus/p-queue), [`p-retry`](https://github.com/sindresorhus/p-retry), [`bottleneck`](https://github.com/SGrondin/bottleneck)
- Caching: [`lru-cache`](https://github.com/isaacs/node-lru-cache)
- Logging: [`pino`](https://github.com/pinojs/pino) with CloudWatch 256KB splitting + sensitive-field redaction

**Per-site base URL overrides:** set `BARNACLE_SITE_<UPPERCASE_SITE_ID>_BASE_URL` to override a plugin's `defaultBaseUrl` without source changes. Underscores in the env key map to hyphens in the `siteId` (e.g. `BARNACLE_SITE_MY_SHOP_BASE_URL` → plugin `my-shop`).

**Execution header:** send `x-barnacle-execution: browser` on any plugin request to skip the hot path and go directly to the Stagehand browser path. Omit the header (or send any other value) to use the default hot path. Useful for debugging or when you know the hot path is broken. (Fastify lowercases incoming header keys; the dispatcher reads `request.headers["x-barnacle-execution"]` — supply lowercase to match.)

## Reference

- Coding standards: [CLAUDE.md](./CLAUDE.md)
- Architecture & design rationale: [docs/architecture.md](./docs/architecture.md)
- Recon playbook (step-by-step): [docs/playbook.md](./docs/playbook.md)
- Configuration (all env vars, deployment, common issues): [docs/configuration.md](./docs/configuration.md)
- Plugin authoring guide: [docs/plugin-authoring.md](./docs/plugin-authoring.md) (runnable example: [examples/plugins/hello-site/](./examples/plugins/hello-site/README.md))
- Testing guide: [docs/testing.md](./docs/testing.md)
- Security policy & vulnerability reporting: [SECURITY.md](./SECURITY.md)
- Telemetry & LLM judging concept guide: [docs/telemetry-and-judging.md](./docs/telemetry-and-judging.md)
- Submission reconciliation runbook (join Barnacle runs to a plugin's own attribution provider's report): [docs/submission-reconciliation.md](./docs/submission-reconciliation.md)
- Per-site recon findings: [docs/target-recon.md](./docs/target-recon.md) (populated after first `pnpm run recon:summarize`)

## License

[MIT](./LICENSE) © Enricai

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).
