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

### The mental model

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

### The pipeline at a glance

| Phase | What runs | What you get |
|-------|-----------|--------------|
| **1 — Browser recon** | `pnpm run recon:browser` | Every API call the site makes, captured to `/tmp/recon/graphql/*.json` |
| **2–3 — HTTP replay + probing** | `pnpm run recon:http` | Proof each endpoint works without a browser; rate-limit ceiling; static fixtures |
| **4 — Plugin generation** | `pnpm run recon:generate` | A complete plugin: Zod schemas, headers, Bottleneck config, hot-path client, Stagehand fallback |
| **5+ — Runtime** | `pnpm start` | Direct HTTP hot path, automatic browser fallback, nightly smoke test, drift detection |

### Why this approach

You will get asked why not just use the browser for every request, or scrape HTML,
or reverse-engineer endpoints by hand. Here is the honest comparison:

| Approach | Cost/req | Latency | Fragile to UI | Fragile to API | Effort |
|----------|----------|---------|---------------|----------------|--------|
| Browser on every request | High | 5–15 s | Medium | Low | Low |
| HTML screen scraper | Low | Low | **High** | Low | Medium |
| Manual DevTools recon | Low | Low | Low | High (human redo) | High (ongoing) |
| HAR replay (mitmproxy) | Low | Low | Medium | **High** | Medium |
| **Recon → codify → direct HTTP + fallback (this)** | **Low** | **Low** | **Low** (re-runnable) | **Low** (fallback covers) | Medium, front-loaded |

The browser-on-every-call approach uses Steel minutes and Anthropic tokens on
every production call — orders of magnitude more expensive at scale. HTML
scrapers break on every UI redesign, and the API response usually carries richer
data than what the UI renders anyway. Manual DevTools recon is exactly what this
pipeline automates, but committed and re-runnable. Front-loaded recon work buys
an integration as cheap as direct HTTP, as robust as a browser fallback, and
maintainable in a way none of the hand-rolled options are.

---

## Adding a New Site — The Recon Playbook

Every new site follows the same pipeline (Phases 0–6). The only human-authored
input is the flow definition you write once in Phase 0. After that, the scripts
run unattended — recon captures, HTTP replay proves endpoints, the generator
writes the plugin. When the site changes months later, you re-run the same
command and diff the captures. Human time is front-loaded to one recon run and
a small PR.

### Phase 0 — Define the user flow

Commit the flow steps to a file first — this makes recon re-runnable in one command without retyping it. When the site changes and you need to re-run recon months later, you `git pull` and run the same command you ran the first time:

```bash
# src/sites/my-site/recon-flow.json
["click the Electronics category filter", "open the first product result"]
```

### Phase 1 — Run the browser recon harness

```bash
# Preferred: load flow from committed file
pnpm run recon:browser -- \
  --url https://example.com \
  --flow-file src/sites/my-site/recon-flow.json

# Or inline (ephemeral — must be re-typed each recon run):
pnpm run recon:browser -- \
  --url https://example.com \
  --flow '["click the Electronics category filter", "open the first product result"]'

# For sites whose API paths don't match /graph, /api/, /graphql, /v1/, or *.json:
pnpm run recon:browser -- \
  --url https://example.com \
  --flow-file src/sites/my-site/recon-flow.json \
  --capture-all

# Capture page-load XHRs only (no interaction — useful for pure GET-style SPAs):
pnpm run recon:browser -- --url https://example.com
```

Drives a real Stagehand + Steel browser through your flow. Captures are wired via a single CDP session-level listener (`page.getSessionForFrame().on(...)`) — Stagehand V3 enables the Network domain internally, so attaching our `Network.requestWillBeSent` / `responseReceived` / `loadingFinished` listeners on the main session catches every response, including the early ones that fire before any page-level handler could be wired.

Captures every network call matching `/graph`, `/api/`, `/graphql`, `/v1/`, or `*.json` to `/tmp/recon/graphql/<NNN>-<phase>-<operationName>.json` — one file per call, diffable and greppable. Use `--capture-all` for sites with non-standard API paths; it captures every response, producing more noise but missing nothing. Omitting both `--flow` and `--flow-file` runs zero interaction steps and captures only the network activity that fires during page navigation — useful for pure GET-style SPAs that fetch everything they need on load.

Each step runs through a self-healing cascade (`act` → `observe + act` → `observe + act` with `ignoreSelectors` → Anthropic-SDK rephrase) verified by network-counter delta or URL change. The script's `main()` attempts up to two global flow replans before giving up; terminal failures dump a diagnostic bundle to `/tmp/recon/step-failures/`. See [docs/playbook.md#1c--self-healing-cascade](./docs/playbook.md#1c--self-healing-cascade) for the full design.

Total runtime: 20–40 minutes for a typical flow (longer if healing or replans fire), fully unattended.

### Phase 2–3 — Replay and probe

```bash
pnpm run recon:http
```

Replays every capture via plain `fetch()` — no browser, no AI — to prove endpoints work standalone. Every replay returning 200 proves the browser is unnecessary for production. Also runs GraphQL introspection, auxiliary fixture detection (static JSON to commit as fixtures), and a rate-limit probe at 1→3→5 rps (run last — if it triggers a ban, all captures are already saved). Results land in `/tmp/recon/replays/`.

See [docs/playbook.md](./docs/playbook.md#interpreting-replay-failures) for the full troubleshooting decision matrix when replays fail.

### Phase 4 — Generate the plugin

```bash
pnpm run recon:generate -- --site-id my-site
```

Reads every artifact from Phases 1–3 — `/tmp/recon/graphql/*.json` (captures), `/tmp/recon/replays/*.json` (replay results), `/tmp/recon/replays/rate-limit.json` (probe findings), `/tmp/recon/aux/*.json` (static fixtures), and `src/sites/my-site/recon-flow.json` — and writes a complete plugin to `src/sites/my-site/`:

- `contract.ts` — Zod schemas inferred from captured JSON, load-bearing headers, Bottleneck ceiling, and `executeHttp` / `execute` implementations
- `flows/browser-flow.ts` — Stagehand fallback wired to your `recon-flow.json` steps
- `index.ts` — barrel export
- `fixtures/` — any static JSON found by the auxiliary probe, already copied in

Then review the generated files: trim UI-only fields from the GraphQL query, narrow any `z.unknown()` entries in the schema you care about, and verify the headers. If you need to regenerate after making changes to the recon flow, pass `--force`.

Optionally generate the human-readable findings doc alongside:

```bash
pnpm run recon:summarize -- --site-id my-site
```

Writes `docs/my-site-recon.md` with: endpoints found, replay status, rate-limit ceiling, header frequency table, and hazards (Akamai, Cloudflare). Without `--site-id`, the default output path is `docs/target-recon.md`.

### Phase 5 — Register the plugin

See **[Plugin Authoring Guide → Register the plugin](#register-the-plugin)** below for the two-line registration in `src/plugins/loader.ts`.

### Phase 6 — Wire up drift detection

See **[Plugin Authoring Guide → Wire up the nightly smoke test](#wire-up-the-nightly-smoke-test)** below for the CI step that runs the smoke test nightly.

See [docs/playbook.md](./docs/playbook.md#phase-6--drift-detection) for the full detection ladder and maintenance loop.

### The whole loop, in one picture

![Barnacle end-to-end workflow: Setup (recon) feeds a dashed Deploys edge into Runtime (dispatch + cache + hot path), Heal catches errors and runs nightly drift detection, and a solid orange arrow sweeps back from smoke-test.ts into Phase 1 to close the self-healing loop.](docs/images/workflow.svg)

The dashed `deploys` edge is the human-in-the-loop step (the contract PR merges and ships to Runtime). The solid orange edge from `smoke-test.ts` back into Phase 1 is the self-healing loop: when the contract drifts, recon reruns unattended (~20–40 min) and the next PR is a diff of captures, not a hand-rewrite. See [docs/architecture.md](./docs/architecture.md) for the design rationale behind each lane.

## Plugin Authoring Guide

A site plugin is a single TypeScript module that satisfies `SitePlugin<TInput, TOutput>`
from `src/site-plugin.ts`. Core's loader discovers it through the static `SITE_PLUGINS`
array in `src/plugins/loader.ts` — no filesystem scanning, no dynamic imports.

### The SitePlugin interface

```ts
interface SitePlugin<TPayload, TResult> {
  meta: SitePluginMeta;
  // Optional direct-HTTP hot path — no browser, no LLM tokens, millisecond latency.
  // Core tries this first; falls back to execute() on HttpSchemaError / HttpBotChallengeError / HttpServerError.
  executeHttp?: (
    payload: TPayload,
    context: SitePluginContext
  ) => Promise<SitePluginResult<TResult>>;
  // Browser fallback — Stagehand + Steel session, acquired from the pool by core.
  execute(
    payload: TPayload,
    session: BrowserSession,
    context: SitePluginContext
  ): Promise<SitePluginResult<TResult>>;
  // Async work is supported. Note: NOT called on CaptchaError or EmptyResultsError —
  // p-retry skips onFailedAttempt for AbortError, so those abort paths bypass this hook.
  onRetry?: (error: ScraperError, attempt: number) => void | Promise<void>;
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
| `taskTimeoutMs?` | `number` | Override the pool's 60-minute per-task hang ceiling for this plugin only — set when the site's normal latency is well below the default and a faster failure is preferable |

### Full plugin skeleton (hot path + browser fallback)

`pnpm run recon:generate` produces this structure automatically. Use `createHttpClient()` for REST endpoints and `createGraphqlClient()` for GraphQL endpoints — `recon:generate` selects the right one based on what it captured. The skeleton below illustrates the REST hot-path pattern; for GraphQL sites, `recon-generate` uses `createGraphqlClient` instead and inlines the captured query as a constant.

```ts
// src/sites/my-site/contract.ts
import Bottleneck from "bottleneck";
import { z } from "zod";
import { createHttpClient } from "@/scraper/http-client";
import type { BrowserSession } from "@/scraper/session";
import type { SitePlugin, SitePluginContext, SitePluginResult } from "@/site-plugin";
import { runMySiteBrowserFlow } from "@/sites/my-site/flows/browser-flow";

// Generated: load-bearing request headers from recon — review and remove anything decorative.
const BASE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json, */*",
  Origin: "https://my-site.com",
  Referer: "https://my-site.com/",
  "User-Agent": "Mozilla/5.0 ...",
};

// Generated: Bottleneck ceiling from Phase 3 rate-limit probe — verify before shipping.
const limiter = new Bottleneck({ minTime: 200 }); // 5 rps safe ceiling

// Generated: Zod schemas inferred from captured JSON — tighten z.unknown() fields as needed.
const MySiteResponseSchema = z.object({ data: z.object({ items: z.array(z.object({ id: z.string() })) }) });
const MySitePayloadSchema = z.object({ query: z.string().min(1) });

type MySitePayload = z.infer<typeof MySitePayloadSchema>;
type MySiteResponse = z.infer<typeof MySiteResponseSchema>;

const httpClient = createHttpClient({ schema: MySiteResponseSchema, bottleneck: limiter, baseHeaders: BASE_HEADERS });

export const mySitePlugin: SitePlugin<MySitePayload, MySiteResponse> = {
  meta: {
    siteId: "my-site",
    displayName: "My Site",
    bodySchema: MySitePayloadSchema,
    responseSchema: MySiteResponseSchema,
    defaultBaseUrl: "https://my-site.com",
  },
  // Hot path: direct HTTP — no browser, no LLM tokens.
  async executeHttp(payload: MySitePayload, context: SitePluginContext): Promise<SitePluginResult<MySiteResponse>> {
    const data = await httpClient(`${context.baseUrl}/api/search`, {
      method: "POST",
      body: JSON.stringify({ query: payload.query }),
    });
    return { data };
  },
  // Browser fallback: Stagehand + Steel — invoked automatically when hot path fails.
  async execute(payload: MySitePayload, session: BrowserSession, context: SitePluginContext): Promise<SitePluginResult<MySiteResponse>> {
    const raw = await runMySiteBrowserFlow(session.stagehand, context.baseUrl, payload.query);
    return { data: raw };
  },
};
```

### The auditPayload hook

`SitePluginResult` accepts an optional `auditPayload` field alongside `data`:

```ts
return {
  data: responseData,
  auditPayload: { query: payload.query, resultCount: responseData.items.length },
};
```

When `auditPayload` is present, core writes it — not `data` — to the submission-envelope telemetry record. Use this to strip PII or large blobs from the audit trail while keeping the full response in the API reply. When absent, `data` is written as-is.

### Static fixtures

If Phase 3b (auxiliary fixture detection) found static JSON endpoints (markets, currencies, labels), `recon:generate` copies them to `src/sites/<id>/fixtures/`. Load them at module init via `loadFixture()` — zero per-request overhead, fails fast on deploy if the fixture is missing or stale:

```ts
import { z } from "zod";
import { loadFixture } from "@/scraper/fixtures";

const MarketsSchema = z.array(z.object({ id: z.string(), name: z.string() }));

// Loaded synchronously at module init. Throws at startup if file is missing
// or shape drifted — surface fixture breakage on deploy, not on the first request.
const markets = loadFixture("my-site", "markets.json", MarketsSchema);
```

See [docs/playbook.md — Phase 3b](./docs/playbook.md#3b--auxiliary-fixture-detection) for how fixtures are detected and when to use them.

### Register the plugin

Add to the `SITE_PLUGINS` array in `src/plugins/loader.ts`:

```ts
import { mySitePlugin } from "@/sites/my-site";

export const SITE_PLUGINS: SitePlugin<unknown, unknown>[] = [
  mySitePlugin as SitePlugin<unknown, unknown>,
];
```

`SITE_PLUGINS.push(mySitePlugin as SitePlugin<unknown, unknown>)` also works for conditional registrations. The array-literal form is preferred for statically known plugins.

Core registers `POST /v1/my-site/run` automatically at startup. No changes to `server.ts`, `config.ts`, or any other core file.

### Wire up the nightly smoke test

Add a step to `.github/workflows/smoke.yml`:

```yaml
- name: Run smoke test — my-site
  if: steps.check-secrets.outputs.skip == 'false'
  run: |
    pnpm run smoke -- \
      --site my-site \
      --payload '{"query":"test"}' \
      --host "$SMOKE_HOST" \
      --fallback \
      --response-schema src/sites/my-site/contract.ts
  env:
    API_KEY: ${{ secrets.SMOKE_API_KEY }}
    SMOKE_HOST: ${{ secrets.SMOKE_HOST }}
    NODE_ENV: production
```

`--response-schema` points to a module whose **default export is a Zod schema**. The smoke test validates the full response body against it — not just the envelope shape — so any schema drift on the data payload fails the pipeline immediately.

`--fallback` additionally runs a second request via the Stagehand browser path. This catches Stagehand cache staleness: if the page DOM changed and the cached selector now points at the wrong element, the hot-path test passes but the fallback test fails — alerting you before the fallback is invoked in production.

### Maintenance loop

When the smoke test fails: re-run `pnpm run recon:browser` → diff `/tmp/recon/graphql/*<operationName>*.json` against `src/sites/<id>/contract.ts` → update query / headers / Zod schema → ship. See [docs/playbook.md](./docs/playbook.md#phase-6--drift-detection) for the full maintenance loop and change severity table.

## Runtime internals

### Hot-path fallback triggers

`dispatch()` (`src/plugins/loader.ts`) tries `executeHttp()` first. Which errors trigger the browser fallback and which don't:

| Hot-path error | Status | Triggers browser fallback? | Reason |
|---------------|--------|--------------------------|--------|
| `HttpSchemaError` | Any | **Yes** | Response shape drifted; browser may still work |
| `HttpBotChallengeError` | 401 / 403 | **Yes** | Residential proxy IP may get through |
| `HttpServerError` | 5xx | **Yes** | Server-side outage; recovery strategy is the same |
| `HttpRateLimitError` | 429 | **No** | A 429 means the configured rps ceiling is too high. Routing to the browser path would just hit the same ceiling and waste a Steel session. The right response is to lower the Bottleneck `minTime` in `contract.ts` and re-deploy. |

### Cache deduplication

`getCachedResponse()` checks the LRU cache first. On a miss, `getOrCreateInFlight()` registers a promise in an `inFlight` map before awaiting it — meaning concurrent identical requests all await the same upstream call rather than fanning out. First caller wins; all others coalesce onto its promise.

Cache key: `<endpoint>:<sha256(canonical payload)[:32]>` — the endpoint is a literal prefix; the hash covers only the canonical payload. Object key order and primitive array element order are normalized so `{a:1,b:2}` and `{b:2,a:1}` hit the same entry. Default TTL: 15 minutes (`CACHE_TTL_MS`). Max entries: 1000 (`CACHE_MAX_ENTRIES`). Only successful responses are cached; errors propagate and never poison the cache.

### Session pool and timeouts

`runWithSession()` (`src/scraper/pool.ts`) queues tasks through a `p-queue` bounded by `SESSION_POOL_SIZE` (default: 3). Sessions are created on demand — not pre-warmed — so Steel billing stays proportional to actual traffic.

**Per-task hang ceiling:** each queued task races against `TASK_TIMEOUT_MS` (`src/scraper/pool.ts`, **60 minutes** by default). A hung `execute()` — frozen CDP connection, infinite network wait — converts to `SessionTimeoutError`, which the retry policy handles by tearing down the broken session and creating a fresh one. The default is sized for long browser flows; shorten per-plugin via `SitePluginMeta.taskTimeoutMs`. This is a hang-recovery floor, not a p99 latency budget.

**Retry policy:** `withScraperRetry` (`src/scraper/retry.ts`) uses p-retry with `factor: 2`, `minTimeout: 500ms`, `maxTimeout: 5000ms`, `randomize: true`, and default `maxAttempts: 3`. `EmptyResultsError` and abort signals short-circuit retries; `SessionTimeoutError` triggers a one-time session restart between attempts.

**Graceful shutdown:** `drainPool()` is called during graceful shutdown — `SIGTERM`/`SIGINT` triggers `app.close()`, which fires Fastify's `onClose` hook, which calls `drainPool()`. It pauses new intake, waits up to 20 seconds for in-flight tasks to close their Steel sessions, then resolves. Without this, process exit leaves live sessions billing until Steel's own timeout.

### Viewport rotation

`createBrowserSession()` (`src/scraper/session.ts`) picks a random desktop viewport per session from: `1280×720`, `1366×768`, `1440×900`, `1920×1080`. A fixed pixel size is an easy bot-detection fingerprint; rotating it makes sessions harder to cluster.

### LLM routing: Anthropic vs. AWS Bedrock

By default, Stagehand calls the Anthropic API directly (`ANTHROPIC_API_KEY`). Set `USE_BEDROCK=true` to route through AWS Bedrock instead:

```bash
USE_BEDROCK=true
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
BEDROCK_MODEL=us.anthropic.claude-sonnet-4-6[1m]   # default
```

The `[1m]` suffix selects the 1-million-token context variant on Bedrock. Both paths run Stagehand with `serverCache: true` (server-side action cache to skip LLM inference on replay) and `selfHeal: false` (recon-browser owns its own verify-and-retry cascade; see `src/scraper/session.ts` for the rationale).

When using Anthropic directly (not Bedrock), the model is controlled by `STAGEHAND_MODEL` (default: `anthropic/claude-sonnet-4-6`).

## Observability

`GET /readyz` returns readiness status plus per-site drift-detection metrics exposed by `src/scraper/metrics.ts`:

```json
{
  "status": "ready",
  "checks": {
    "database": { "ok": true },
    "scraperCredentials": { "ok": true },
    "scraperPool": { "ok": true, "detail": "depth=0" }
  },
  "stats": {
    "scraperPool": { "size": 0, "pending": 0, "concurrency": 3 },
    "cache": { "size": 12, "max": 1000, "inFlight": 0 },
    "metrics": {
      "my-site": {
        "hotPathSuccess": 4821,
        "fallbackActivations": 3,
        "rateLimitRejections": 0,
        "p95LatencyMs": 187
      }
    }
  },
  "telemetry": {
    "currentRunFile": "/path/to/.barnacle/events/run-123.ndjson",
    "currentRunFileSizeBytes": 4096,
    "orphansRecovered": 0
  },
  "heal": {
    "my-site": { "verdict": "SUCCESS", "bestPassRate": 0.95, "reportPath": "heal-out/my-site/healing-my-site.md" }
  }
}
```

**What rising `fallbackActivations` means:** the hot path is failing and the browser fallback is absorbing traffic. Cost and latency rise while error rate stays flat — users don't notice yet, but you will on your bill. This is your signal to re-run recon.

**`p95LatencyMs`** is reservoir-sampled (Vitter's Algorithm R, capped at 1000 samples) over actual upstream round-trips. Cache hits are excluded — they're memory reads and must not bias the upstream latency signal.

See [docs/playbook.md](./docs/playbook.md#6b--metrics-signals-the-detection-ladder) for the full detection ladder.

### NDJSON telemetry files

Barnacle writes two append-only NDJSON files alongside its metrics:

| File | Default path | Purpose |
|------|-------------|---------|
| LLM call samples | `.barnacle/calls.ndjson` | One line per LLM/Stagehand call; feed to the `judge:llm` and `slm-self-heal` skills |
| Run event stream | `.barnacle/events/<runId>.ndjson` | Per-run event stream written by the event-stream subsystem; path surfaced in `/readyz` `telemetry.currentRunFile` |

#### LLM call sample schema

Every line in `.barnacle/calls.ndjson` is a JSON object with these fields (source: `src/api/schemas/telemetry.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `callId` | `string` | UUID generated per call |
| `callType` | `string` | Which LLM call site produced this sample — see table below |
| `model` | `string` | Model identifier string passed to the SDK |
| `systemPrompt` | `string \| null` | System-prompt text, or `null` when absent |
| `userContent` | `string` | Full user-turn content |
| `responseContent` | `string \| null` | Raw response text, or `null` on SDK error |
| `parsedOk` | `boolean` | Whether the response was successfully parsed into the expected schema |
| `inputTokens` | `number \| null` | Input token count from SDK usage metadata |
| `outputTokens` | `number \| null` | Output token count from SDK usage metadata |
| `latencyMs` | `number \| null` | Wall-clock latency of the SDK call in milliseconds |
| `success` | `boolean` | Whether the call site considered the call successful end-to-end |
| `ts` | `string` | ISO-8601 timestamp at write time |

#### Call types

`callType` is a stable string constant defined in `src/lib/telemetry/call-types.ts`:

| `callType` | Source | When emitted |
|------------|--------|--------------|
| `recon-rephrase` | `src/scripts/recon-browser.ts` | Attempt-4 rephrase inside the recon-browser step-healing cascade — Anthropic SDK is asked to reword the failing step |
| `recon-replan` | `src/scripts/recon-browser.ts` | Global replan after a step terminally fails — Claude rewrites the remaining flow tail |
| `recon-flow-patch` | `src/scripts/recon-heal.ts` | Patch proposal from the recon-flow-patch-generator during the `recon-heal` self-healing loop |
| `llm-prompt-patch` | `src/scripts/llm-heal.ts` | Patch proposal from the llm-call-patch-generator during the `llm-heal` self-healing loop |

#### Tailing call samples with jq

```bash
# Stream all LLM call samples as they arrive
tail -f .barnacle/calls.ndjson | jq '.'

# Filter to a specific call type
tail -f .barnacle/calls.ndjson | jq 'select(.callType == "recon-rephrase")'

# Show only failures
tail -f .barnacle/calls.ndjson | jq 'select(.success == false) | {callId, callType, latencyMs}'

# Token usage summary by call type
jq -s 'group_by(.callType) | map({callType: .[0].callType, totalInputTokens: map(.inputTokens // 0) | add, totalOutputTokens: map(.outputTokens // 0) | add, n: length})' .barnacle/calls.ndjson

# Tail the current run event stream (path from /readyz telemetry.currentRunFile)
tail -f .barnacle/events/<runId>.ndjson | jq '.'
```

## Environment variables

All variables are read once at process start. Required variables cause the
process to exit on missing values; optional ones have safe defaults.

### Application

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `APP_NAME` | `barnacle` | No | Application name used in logs |
| `NODE_ENV` | `development` | No | `development` / `production` / `test` |
| `PORT` | `3000` | No | HTTP listen port |
| `HOST` | `0.0.0.0` | No | HTTP listen address |
| `LOG_LEVEL` | `info` | No | Pino log level (`debug`, `info`, `warn`, `error`) |

### Auth

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `API_KEYS_HASHED` | `""` | Yes (prod) | Comma-separated bcrypt hashes of plaintext bearer tokens. See [Generating an API key](#generating-an-api-key). |
| `DEV_BYPASS_AUTH` | `false` | No | Skip auth entirely. Local dev only — **never set in production**. |

### Browser automation (Steel + Stagehand)

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `STEEL_API_KEY` | — | **Yes** | Steel account API key. Required for all browser automation. |
| `ANTHROPIC_API_KEY` | — | Yes (if not using Bedrock) | Anthropic API key for Stagehand's LLM calls. |
| `STAGEHAND_MODEL` | `anthropic/claude-sonnet-4-6` | No | Stagehand model. Use the `anthropic/` prefix — Stagehand 2.x's model map is stale and the prefix routes through AI-SDK's fallback path. |
| `SCRAPER_PROXY_TYPE` | `residential` | No | `residential` (paid Steel tiers) or `none` (free tier — Steel rejects `useProxy=true` on hobby plans). |
| `SCRAPER_SOLVE_CAPTCHA` | `true` | No | Enable Steel's built-in CAPTCHA solver. Requires a paid plan; set `false` on the free tier. |
| `SESSION_POOL_SIZE` | `3` | No | Maximum concurrent Steel browser sessions. |
| `SCRAPER_MIN_ACTION_DELAY_MS` | `500` | No | Minimum delay between scraper actions (ms). Jitter applied on top. |
| `SCRAPER_MAX_ACTION_DELAY_MS` | `1500` | No | Maximum delay between scraper actions (ms). |
| `STAGEHAND_API_TIMEOUT_MS` | `120000` | No | Anthropic SDK request timeout (ms). Raise on slow network paths to `api.anthropic.com`. |
| `STAGEHAND_CONNECT_TIMEOUT_MS` | `120000` | No | TCP connect timeout for all outbound fetch calls (ms). Raised from the undici default of 10 s to match `STAGEHAND_API_TIMEOUT_MS`. |
| `STEEL_SESSION_TIMEOUT_MS` | `3600000` | No | Steel session wall-clock timeout (ms). Default is 1 hour; lower on plans that enforce shorter maximum session durations. |

### AWS Bedrock (alternative LLM provider)

Set `USE_BEDROCK=true` to route Stagehand's LLM calls through AWS Bedrock
instead of the Anthropic API. When enabled, `ANTHROPIC_API_KEY` is not needed.
AWS credentials resolve in standard SDK order: explicit vars → ECS task role →
EC2 instance profile → `~/.aws/credentials`.

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `USE_BEDROCK` | `false` | No | Master switch — routes LLM calls through Bedrock when `true`. |
| `AWS_REGION` | `us-east-1` | No | AWS region for Bedrock calls. |
| `AWS_ACCESS_KEY_ID` | — | No | Explicit AWS access key (leave blank for ambient IAM). |
| `AWS_SECRET_ACCESS_KEY` | — | No | Explicit AWS secret key. |
| `AWS_SESSION_TOKEN` | — | No | Required only for temporary STS credentials. |
| `BEDROCK_MODEL` | `us.anthropic.claude-sonnet-4-6[1m]` | No | Bedrock cross-region inference profile ID. The `us.` prefix enables automatic cross-region routing; the `[1m]` suffix selects the 1M-token context variant. |

### Cache

| Variable | Default | Purpose |
|----------|---------|---------|
| `CACHE_TTL_MS` | `900000` (15 min) | LRU response cache TTL. Cached responses skip the target API entirely. |
| `CACHE_MAX_ENTRIES` | `1000` | Maximum entries in the LRU cache. |

### Rate limiting (inbound)

These limit traffic *to* Barnacle's own API. See per-plugin Bottleneck config
in each `contract.ts` for outbound rate limits to target sites.

| Variable | Default | Purpose |
|----------|---------|---------|
| `RATE_LIMIT_MAX` | `120` | Max requests per window per API key (or IP for unauthenticated traffic). |
| `RATE_LIMIT_WINDOW_MS` | `60000` (1 min) | Rate limit window duration. |
| `TRUST_PROXY` | `true` | Trust `X-Forwarded-For` when behind a reverse proxy. Set `false` for bare-metal deploys to prevent spoofing. |

### Readiness / observability

| Variable | Default | Purpose |
|----------|---------|---------|
| `READINESS_QUEUE_THRESHOLD` | `20` | `/readyz` returns 503 when scraper queue depth exceeds this. Lets orchestrators shed load before the pool is saturated. |
| `ENABLE_DOCS` | `false` | Serve Swagger UI at `/docs`. Disable in production. |

### Telemetry

| Variable | Default | Purpose |
|----------|---------|---------|
| `TELEMETRY_ENABLED` | `true` | Master switch — set `false` to disable all NDJSON telemetry writes. |
| `TELEMETRY_EVENTS_DIR` | `.barnacle/events` | Directory for per-run NDJSON event stream files (`<eventsDir>/<runId>.ndjson`). |
| `CALLS_NDJSON_PATH` | `.barnacle/calls.ndjson` | Append-only NDJSON sink for LLM/Stagehand call samples. One line per call; feed to the judge and self-heal skills. |
| `SUBMISSIONS_NDJSON_PATH` | `.barnacle/submissions.ndjson` | Append-only NDJSON sink for dispatch submission envelopes. One line per plugin invocation captures siteId, requestId, inbound payload, status, audit payload, and duration — the durable source-of-truth for "what did we submit for jobId X and did it succeed." |
| `TELEMETRY_MAX_FILE_SIZE_BYTES` | `104857600` (100 MB) | Rotate/drop the calls NDJSON once it exceeds this byte count. |
| `TELEMETRY_MAX_RETENTION_MS` | `2592000000` (30 days) | Drop event-stream files older than this many milliseconds. |
| `TELEMETRY_S3_BUCKET` | — | Optional — destination bucket for the buffered S3 telemetry mirror. Sink is entirely inert (no client, no network calls) when unset. Credentials/region resolve the same way as Bedrock (`AWS_REGION`, standard SDK credential order). |
| `TELEMETRY_S3_PREFIX` | `telemetry` | Key prefix for uploaded NDJSON objects (`<prefix>/<calls\|submissions>/<date>/...`). |
| `TELEMETRY_S3_FLUSH_INTERVAL_MS` | `60000` | How often buffered lines are flushed to S3. |
| `TELEMETRY_S3_MAX_BUFFER_LINES` | `500` | Threshold-flush trigger — flush early if either buffer exceeds this many lines, ahead of the next scheduled interval. |

### LLM judging

| Variable | Default | Purpose |
|----------|---------|---------|
| `JUDGE_MODEL` | `us.anthropic.claude-sonnet-4-6[1m]` | Anthropic model used by the judge script. Reuses Bedrock creds via the cross-region inference profile. |
| `JUDGE_TEMPERATURE` | `0.2` | Sampling temperature for judge LLM calls. Keep low (≤ 0.3) for deterministic verdicts. |
| `JUDGE_BATCH_SIZE` | `10` | Number of call samples sent to the judge in one LLM request. |
| `JUDGE_TIMEOUT_MS` | `120000` (2 min) | Anthropic SDK request timeout for judge calls. |

### Self-heal

| Variable | Default | Purpose |
|----------|---------|---------|
| `SELFHEAL_MAX_ITERATIONS` | `5` | Maximum patch→replay→score iterations before BUDGET_EXHAUSTED. |
| `SELFHEAL_N_REPLAYS` | `5` | Number of replay runs per iteration arm. |
| `SELFHEAL_SUCCESS_THRESHOLD` | `0.9` | Minimum pass rate (0–1) to declare SUCCESS and stop iterating. |
| `SELFHEAL_PLATEAU_WINDOW` | `3` | Consecutive iterations below `SELFHEAL_PLATEAU_DELTA` that triggers PLATEAUED. |
| `SELFHEAL_PLATEAU_DELTA` | `0.03` | Minimum absolute pass-rate improvement per iteration to count as progress. |
| `SELFHEAL_TIMEOUT_MS` | `60000` (1 min) | Per-replay LLM request timeout. |

### Per-site base URL overrides

Set `BARNACLE_SITE_<UPPERCASE_SITE_ID>_BASE_URL` to override a plugin's
`defaultBaseUrl` without source changes. Underscores in the env key map to
hyphens in the `siteId`:

```bash
BARNACLE_SITE_MY_SHOP_BASE_URL="https://staging.my-shop.com"  # overrides plugin `my-shop`
```
---

## Usage

### Prerequisites

- Node.js 22+
- pnpm 10.4.1
- A Steel account (`STEEL_API_KEY`) for managed browser sessions
- An Anthropic key (`ANTHROPIC_API_KEY`) for Stagehand's LLM calls, **or** AWS Bedrock (`USE_BEDROCK=true` + AWS credentials) — see `.env.example` for details

### Install

```bash
pnpm install
cp .env.example .env   # fill in STEEL_API_KEY and either ANTHROPIC_API_KEY or Bedrock creds
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

For local development, set `DEV_BYPASS_AUTH=true` in `.env` to skip auth
entirely — never set this in production.

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

Barnacle ships with no plugins registered — `SITE_PLUGINS` in `src/plugins/loader.ts` is empty by default. Follow [Adding a New Site](#adding-a-new-site--the-recon-playbook) above to build and register a plugin; core will register `POST /v1/<your-siteId>/run` automatically at startup.

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

Every response — success or error — uses the same envelope shape so clients share a single parser. Error details appear in `status.details[]` with numeric codes:

| Code | Name | When |
|------|------|------|
| 1000 | `PARTIAL_CONTENT_SUCCESS` | Partial data returned |
| 1001 | `DECODING_ERROR` | Request body could not be parsed |
| 1002 | `FIELD_VIOLATION` | Schema validation failure on a field |
| 1003 | `EMPTY_REQUEST` | Request body was missing or empty |
| 1004 | `AUTHORIZATION_ERROR` | Bearer token missing or invalid |
| 1005 | `RESOURCE_NOT_FOUND` | Requested resource does not exist |
| 1006 | `INDEX_NOT_FOUND` | Internal index lookup failed |
| 1007 | `CLIENT_CALL_ERROR` | Downstream client call failed |
| 1008 | `GENERIC_ERROR` | Unclassified server error |
| 1009 | `EXTRA_DETAIL` | Supplemental detail entry (informational) |
| 1010 | `THROTTLED_REQUEST` | Rate limit exceeded (hot path 429) |
| 1011 | `TIME_OUT` | Request timed out |
| 2003 | `SCRAPE_FAILURE` | Browser automation failed after retries |
| 2004 | `CAPTCHA_ENCOUNTERED` | CAPTCHA challenge could not be resolved |
| 2005 | `EMPTY_RESULTS` | Scrape succeeded but returned no data |

Full definitions: `src/api/schemas/common.ts`.

**How scraper exceptions map to API codes** (`src/plugins/loader.ts:149-153`):

- `CaptchaError` → `2004 CAPTCHA_ENCOUNTERED`
- `EmptyResultsError` → `2005 EMPTY_RESULTS`
- `HttpRateLimitError` → `1010 THROTTLED_REQUEST` (no browser fallback)
- Any other `ScraperError` → `2003 SCRAPE_FAILURE`
- Task exceeded `TASK_TIMEOUT_MS` → `1011 TIME_OUT`

## Endpoints

Each registered plugin exposes a POST route following the default convention:
`POST /v1/<siteId>/run`.

Operational routes:
- `GET /healthz` — liveness probe
- `GET /readyz`  — readiness probe (checks scraper credentials, queue depth)
- `GET /docs`    — Swagger UI (when `ENABLE_DOCS=true`)

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
├── server.ts                  # Fastify bootstrap — calls registerRoutes(), site-agnostic
├── site-plugin.ts             # SitePlugin<TInput,TOutput> interface (engine contract)
├── config.ts                  # frozen env-typed config singleton
├── plugins/
│   └── loader.ts              # SITE_PLUGINS registry, dispatch(), registerRoutes()
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
│   ├── session.ts             # Steel + Stagehand session factory
│   ├── pool.ts                # p-queue over createBrowserSession
│   ├── throttle.ts            # Bottleneck limiter + jitter
│   ├── retry.ts               # p-retry + failure classification
│   ├── errors.ts              # typed scraper error hierarchy
│   ├── http-client.ts         # typed fetch wrapper (hot path)
│   ├── http-status-classifier.ts # pure status→ScraperError classifier for raw-fetch callers
│   ├── raw-fetch.ts           # site-agnostic undici scaffold: network-error wrap, onResponse hook, optional classifyHttpStatus (skipClassify for callers that classify manually)
│   ├── graphql-client.ts      # GraphQL POST wrapper
│   ├── metrics.ts             # drift-detection counters
│   ├── fixtures.ts            # static JSON fixture loader
│   ├── navigate.ts            # shared awaitActivePage + goto(networkidle) helper
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
- Browser automation: [`@browserbasehq/stagehand`](https://github.com/browserbase/stagehand) + [`steel-sdk`](https://steel.dev)
- Concurrency: [`p-queue`](https://github.com/sindresorhus/p-queue), [`p-retry`](https://github.com/sindresorhus/p-retry), [`bottleneck`](https://github.com/SGrondin/bottleneck)
- Caching: [`lru-cache`](https://github.com/isaacs/node-lru-cache)
- Logging: [`pino`](https://github.com/pinojs/pino) with CloudWatch 256KB splitting + sensitive-field redaction

**Per-site base URL overrides:** set `BARNACLE_SITE_<UPPERCASE_SITE_ID>_BASE_URL` to override a plugin's `defaultBaseUrl` without source changes. Underscores in the env key map to hyphens in the `siteId` (e.g. `BARNACLE_SITE_MY_SHOP_BASE_URL` → plugin `my-shop`).

**Bypass header:** send `x-barnacle-force-fallback: true` on any plugin request to skip the hot path and go directly to the Stagehand browser path. Useful for debugging or when you know the hot path is broken. (Fastify lowercases incoming header keys; the dispatcher reads `request.headers["x-barnacle-force-fallback"]` — supply lowercase to match.)

---

## Deployment

### Production checklist

```bash
# .env (production)
NODE_ENV=production
ENABLE_DOCS=false         # never expose Swagger in prod
TRUST_PROXY=true          # set false if deploying directly to the internet (no ALB/nginx)
DEV_BYPASS_AUTH=false     # this is the default — confirm it's not set to true
API_KEYS_HASHED="<bcrypt-hash>,<bcrypt-hash>"  # at least one key
STEEL_API_KEY="..."
ANTHROPIC_API_KEY="..."   # or USE_BEDROCK=true + AWS creds
```

### Process management

Barnacle is a plain Node.js process. Use pm2 or systemd to keep it alive and
restart it on crash:

```bash
# pm2
pm2 start dist/server.js --name barnacle --env production
pm2 save && pm2 startup

# systemd (example unit)
[Service]
ExecStart=/usr/bin/node /srv/barnacle/dist/server.js
WorkingDirectory=/srv/barnacle
EnvironmentFile=/srv/barnacle/.env
Restart=on-failure
```

### Reverse proxy

Route traffic through nginx or an Application Load Balancer (ALB). Set
`TRUST_PROXY=true` so Fastify uses `X-Forwarded-For` for the client IP
(needed for rate limiting on unauthenticated traffic).

```nginx
location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   Host $host;
}
```

### Health probes

Wire `/healthz` as the liveness probe and `/readyz` as the readiness probe:

```yaml
# Kubernetes example
livenessProbe:
  httpGet: { path: /healthz, port: 3000 }
  initialDelaySeconds: 5
readinessProbe:
  httpGet: { path: /readyz, port: 3000 }
  initialDelaySeconds: 10
```

`/readyz` returns 503 when the scraper pool queue is saturated (depth >
`READINESS_QUEUE_THRESHOLD`) or when required scraper credentials are missing.

---

## Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Error: STEEL_API_KEY is required` | Missing env var | Add `STEEL_API_KEY` to `.env` |
| `useProxy rejected` / `402` from Steel | Free-tier plan doesn't support residential proxies | Set `SCRAPER_PROXY_TYPE=none` and `SCRAPER_SOLVE_CAPTCHA=false` |
| `401 Unauthorized` on every request | No API key configured or wrong plaintext key | Verify `API_KEYS_HASHED` is set; double-check the plaintext key. For dev, set `DEV_BYPASS_AUTH=true` |
| Stagehand throws `model not found` | Wrong model name format | Use the `anthropic/` prefix: `STAGEHAND_MODEL=anthropic/claude-sonnet-4-6` |
| `/readyz` returns 503 on `scraperCredentials` | `STEEL_API_KEY` or LLM key missing | Set the missing credential |
| Build succeeds but `dist/sites/` is empty | `tsc` ran but `cp -r src/sites dist/sites` was skipped | Run `pnpm run build` (not `tsc` directly) — the build script copies site sources after compilation |

---

## Reference

- Coding standards: [CLAUDE.md](./CLAUDE.md)
- Architecture & design rationale: [docs/architecture.md](./docs/architecture.md)
- Recon playbook (step-by-step): [docs/playbook.md](./docs/playbook.md)
- Testing guide: [docs/testing.md](./docs/testing.md)
- Telemetry & LLM judging concept guide: [docs/telemetry-and-judging.md](./docs/telemetry-and-judging.md)
- Per-site recon findings: [docs/target-recon.md](./docs/target-recon.md) (populated after first `pnpm run recon:summarize`)

## License

[MIT](./LICENSE) © Enricai

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).
