# Barnacle Recon Playbook

> Turn a website into an API. A fully automated pipeline — scripts handle recon,
> replay, and drift detection with minimal human involvement. You write the flow
> once; the tooling does the rest.

**Outcome:** a production plugin whose hot path is ~50 lines of `fetch()` plus
headers, with an AI-browser fallback, automated drift detection, and a body of
captured evidence that justifies every design choice. Human time is front-loaded
to one recon run and a small PR when things change.

---

## Mental model

> *Stagehand is the teacher. The runtime is a student who only needs to open the
> textbook. Every phase runs from a script — human involvement is writing the
> flow definition once, then reviewing a PR when the site changes.*

Modern SPAs are thick clients. The page is just a shell — all the data you care
about flows through the network layer as GraphQL or JSON API calls. The browser
already knows how to make those calls correctly. Recon uses an AI-driven browser
to *learn* the exact bytes the site sends, then discards the browser in
production and sends those same bytes directly.

The browser is the oracle. After Step 1, you don't need it anymore — until the
site changes.

---

## The pipeline at a glance

| Phase | Script / action | Automation |
|-------|-----------------|------------|
| 0 — Define flow | `src/sites/<id>/recon-flow.json` | Human (once) |
| 1 — Browser recon | `pnpm run recon:browser` | Fully automated |
| 2 — HTTP replay | `pnpm run recon:http` | Fully automated |
| 3 — Edge probing | (same script) | Fully automated |
| 4 — Codify contract | `src/sites/<id>/contract.ts` | One human PR |
| 5 — Runtime | `dispatch()` in `src/plugins/loader.ts` | Fully automated |
| 6 — Drift detection | Nightly smoke test + `/readyz` metrics | Fully automated |

---

## Phase 0 — Define the user flow

The only human-authored input to the entire pipeline. Write down the narrowest
sequence of user actions whose data you care about, as a JSON array of
natural-language instructions. Commit it alongside your plugin:

```
src/sites/<id>/recon-flow.json
```

```json
["click the Electronics category filter", "open the first product result"]
```

**Why commit it:** committing the flow makes recon re-runnable in one command
without retyping it. When the site changes and you need to re-run recon, you
`git pull` and run the same command you ran the first time.

Aim for the narrowest flow that triggers the network calls you need. More steps
= more captures = more noise. You can always run wider later.

**Pure GET-style SPAs:** if the target site fetches everything it needs on
initial page load, you can skip the flow entirely — run `recon:browser --url X`
with neither `--flow` nor `--flow-file` and the script will capture only the
network activity that fires during navigation.

---

## Phase 1 — Browser recon (`recon-browser.ts`)

```bash
pnpm run recon:browser -- \
  --url https://example.com \
  --flow-file src/sites/my-site/recon-flow.json

# For sites whose API paths don't match /graph, /api/, /graphql, /v1/, or *.json:
pnpm run recon:browser -- \
  --url https://example.com \
  --flow-file src/sites/my-site/recon-flow.json \
  --capture-all
```

**Total runtime: 20–40 minutes for a typical flow (varies with flow length,
`STEP_PAUSE_MS`, and any healing/replan attempts that fire). Fully unattended.**

### 1a — Session bootstrap

The script calls `createBrowserSession()` (`src/scraper/session.ts`), which
constructs the Stagehand instance with two intentional flags:

- `serverCache: true` — Stagehand's server-side action cache skips LLM
  inference on replay. After the first run against a page structure, subsequent
  `act()` calls resolve from cache in milliseconds.
- `selfHeal: false` — explicitly off. Stagehand's built-in self-heal only fires
  on Playwright throws (element-not-found, intercepted, timeout); it does *not*
  catch the silent semantic miss ("clicked the wrong thing, returned success"),
  which is the primary failure mode for ambiguous instructions. Recon-browser
  owns its own verify-and-retry cascade — see 1c. The runtime fallback uses a
  separate whole-flow retry via `withScraperRetry` in `src/scraper/retry.ts`,
  with Zod as the verifier.

### 1b — CDP session-level network capture

A single listener attaches to the page's main CDP session:

```ts
const session = page.getSessionForFrame(page.mainFrameId());
session.on("Network.requestWillBeSent", onRequest);
session.on("Network.responseReceived", onResponse);
session.on("Network.loadingFinished", onFinished);
```

Stagehand V3 already enables the Network domain internally, so attaching at
the session layer catches every response — including the early ones that fire
during navigation, before any page-level handler could be wired up. We pair
`requestWillBeSent` / `responseReceived` / `loadingFinished` via `requestId` so
we only fetch the response body after it's fully received.

By default, the filter captures paths matching `/graph`, `/api/`, `/graphql`,
`/v1/`, or `*.json`. Use `--capture-all` for sites with non-standard API paths —
it captures every network response, producing more noise but missing nothing.

Each capture records, untruncated:
- Timestamp, method, URL, status
- Request headers and post body
- Response headers and body
- `operationName`, `query`, `variables` (parsed from GraphQL POST bodies)
- Phase tag (e.g. `home`, `filter`, `detail`)

### 1c — Self-healing cascade

Each flow step runs through `executeStepWithHealing` (`src/scripts/recon-browser.ts`),
which is a 4-attempt escalating cascade. We stop the moment an attempt is
verified successful; the verifier is "did the network counter advance OR did the
URL change" (DOM-state verification was tried and removed — see the source
comments for why).

```
flow step "X"
  │
  ├── attempt 1: stagehand.act("X")
  │     └── verify: network counter delta || page.url() change?
  │           ├── yes → step healed, move on
  │           └── no  → fall through
  │
  ├── attempt 2: stagehand.observe("X") → act(topAction)
  │     └── verify: same signals
  │
  ├── attempt 3: stagehand.observe("X", { ignoreSelectors: tried })
  │              → act(topAction)
  │     └── verify: same signals
  │
  ├── attempt 4: Anthropic SDK rephrase("X", page, tried, candidates)
  │              → stagehand.act(rephrased)
  │     └── verify: same signals
  │
  └── all exhausted → dumpStepFailure() + throw StepVerificationError
```

The recon script calls `stagehand.act()` (not `page.act()`); the four
techniques are, in order:

1. **`act(string)`** — the cheap path. Stagehand resolves the natural-language
   instruction against the current DOM.
2. **`observe()` + `act(Action)`** — Stagehand returns a list of candidate
   `Action` objects with `selector` + `description`. We pick the top candidate
   and call `act` on the structured object directly. Disambiguates without
   needing rephrase.
3. **`observe(step, { ignoreSelectors: tried })` + `act(Action)`** — same as
   attempt 2, but we tell Stagehand to exclude the selectors we already tried.
   Addresses the "same wrong button twice" failure mode. When no selectors
   were captured from earlier attempts (rare — usually means both attempts
   found nothing actionable), attempt 3 degenerates to a plain `observe(step)`
   and acts like a second pass of attempt 2.
4. **Anthropic SDK rephrase** — final escape hatch. We call Claude directly
   with the original step, the failure reasons from attempts 1–3, the selectors
   already tried, and the first ~12 visible interactive elements from
   `stagehand.observe()`. Claude returns a rephrased instruction; we `act` on
   it. On Bedrock-only deployments this attempt is skipped (no Anthropic key);
   the cascade ends at attempt 3 with a startup warn.

Backoff between attempts: linear `attempt * 1000ms`. Verification is OR'd
across network + URL; the network counter is the primary signal because recon
exists to capture API calls.

### 1d — Step failure dump

When the cascade exhausts, the executor writes a diagnostic bundle to
`/tmp/recon/step-failures/<NNN>-<phase>.json` and throws `StepVerificationError`
(`src/scraper/errors.ts`). The bundle has top-level keys:

- `timestamp`, `stepIndex`, `phase`, `originalStep`
- `pageUrl`, `pageTitle`
- `attempts[]` — every attempt's `technique` (one of `act-string`,
  `observe-act`, `observe-act-exclude`, `llm-rephrase`), `instruction`,
  `triedSelectors`, `actResultSuccess`, `actResultDescription`, `errorMessage`,
  `pre`/`post` snapshots
- `finalObserve[]` — what Stagehand could see at the point of giving up
- `recentCaptures[]` — the last 5 capture filenames (helps locate what API
  calls *did* fire just before the broken step)

This is the artifact the operator reads to fix the flow. If the global replan
loop (1e) doesn't recover, the dump is everything you need to edit the source
`--flow-file` and rerun. The `.claude/agents/recon-flow-patch-generator`
subagent automates the analysis: pass it the dump, the step verdict, and the
current flow JSON and it returns a minimal `{anchor, replacement}` patch for
the failing step — verified mechanically before it is applied.

For repeated or intermittent failures, `pnpm run recon:heal -- --site-id <id>
--url <url>` orchestrates the full baseline → patch → replay → convergence
loop automatically: it proposes patches, replays the patched flow, scores each
arm, and writes `heal-out/<id>/healing-<id>.md` with the verdict and best patch
for manual review. The source `recon-flow.json` is never modified.

### 1e — Global replan loop

When `StepVerificationError` reaches the `main()` loop, it triggers a global
replan rather than failing immediately. Claude is asked to rewrite the
remaining tail of the flow given the failure context. Capped at
`MAX_REPLANS = 2` per run.

```
StepVerificationError caught in main() loop
  │
  ├── replansUsed >= MAX_REPLANS (2)? → rethrow, recon fails
  │
  ├── no Anthropic client (Bedrock-only)? → rethrow
  │
  └── replanRemainingFlow(originalFlow, completed, failed,
                          remaining, page.url(), title,
                          observe() candidates, dumpPath)
        │
        ├── returns IMPOSSIBLE / unparseable → rethrow
        │
        └── returns new tail (1..REPLAN_MAX_STEPS strings)
              │
              ├── dumpReplanRecord(...) → .replan.json
              ├── plan.splice(i, plan.length - i, ...newSteps)
              ├── i--
              └── continue loop on the new tail
```

Replan inputs:

- The original flow as the user wrote it.
- The verbatim steps that already succeeded (held fixed — already-completed
  history is never rewritten).
- The step that just failed.
- The remaining unexecuted steps.
- Current `page.url()` and `page.title()`.
- The first ~12 candidates from `stagehand.observe()`.
- The path on disk to the step failure dump from 1d.

Replan output: strict JSON array of 1..`REPLAN_MAX_STEPS` (20) instruction
strings, validated with `z.array(z.string().min(1)).min(1).max(REPLAN_MAX_STEPS)`.
If Claude returns the literal `IMPOSSIBLE` or the response fails to parse, the
loop rethrows the original `StepVerificationError`.

When replan succeeds it writes a sibling audit record at
`/tmp/recon/step-failures/<NNN>-<phase>.replan.json` with `{ timestamp,
stepIndex, phase, replanIndex, completedSteps, originalRemaining,
newRemaining }`, then splices the new tail into the live plan and resumes
execution. The `--flow-file` on disk is *not* modified — humans still own the
canonical source.

### 1f — Per-call capture files

Each captured response is written to its own numbered JSON file:

```
/tmp/recon/graphql/000-home-productSearch_Products.json
/tmp/recon/graphql/007-detail-product_Detail.json
```

One file per call keeps captures diffable and greppable. `git diff` on a
second recon run against the first immediately shows which operations changed
shape.

### 1g — Parameter decoding

Opaque POST body parameters are decoded automatically: the script tries
JSON → URL-encoded → base64, and saves the decoded result alongside the
capture. This handles sites that double-encode filter state into query strings.

---

## Phase 2 — HTTP replay (`recon-http.ts`)

```bash
pnpm run recon:http
```

`recon-http.ts` answers the pivotal question: *Does the server care that a real
browser was on the other end, or will it answer anyone who sends the right bytes?*

No Stagehand, no Steel, no Playwright. The script walks
`/tmp/recon/graphql/*.json`, deduplicates by `url|operationName|variables`, and
reissues each capture via Node's built-in `fetch()`.

### The minimal header set (RC_HEADERS)

The replay uses only the load-bearing header subset:

```
Content-Type: application/json
Accept: application/json, */*
Origin: https://example.com
Referer: https://example.com/
User-Agent: Mozilla/5.0 ...
```

**Start minimal.** Cookies and auth tokens are almost always unnecessary on
public endpoints. Adding them makes it harder to isolate which headers actually
matter. If a replay fails, add headers one at a time until it passes — the
header you just added was load-bearing.

Each replay is saved to `/tmp/recon/replays/` with status, headers, body, and a
link back to the source capture.

**Every replay returning 200 with a matching shape proves the browser is
unnecessary for production.**

### Interpreting replay failures

| Symptom | Likely cause | Response |
|---------|-------------|----------|
| `403` on every replay | Browser fingerprinting / bot manager | Add more headers; if still `403`, accept Stagehand-only production |
| `401` on every replay | Session auth required | Capture the token, determine its lifetime, build a refresh strategy |
| `200` but empty body | Missing `Origin` / `Referer` | Add them and retry immediately |
| `200` on home, `500` on detail | Detail query references a session variable | Look for differing headers between working/failing replays; likely a CSRF token |
| Replay passes sporadically | Rate limit already triggered from recon | Pause, switch IP, reduce rps ceiling |
| Replays fine for a week, then fail | Target site changed schema | Re-run Phases 1–4, diff captures against committed queries, ship the delta |

---

## Phase 3 — Edge probing (`recon-http.ts`, still automated)

Run together with Phase 2 in the same script invocation.

### 3a — GraphQL introspection

Sends `{ __schema { types { name } } }` to each unique GraphQL endpoint. If
introspection is enabled, the full schema is dumped — it's gold for reviewing
the inferred Zod types that `recon-generate` produces. If disabled,
`recon-generate` infers Zod schemas directly from the captured JSON bodies.

### 3b — Auxiliary fixture detection

Finds static JSON endpoints in the captures (markets, currencies, labels,
dictionaries), downloads them, and flags them as fixtures to commit. A fixture
is any response that changes rarely enough that it can be baked into the
codebase — load it at startup via `src/scraper/fixtures.ts` rather than
re-fetching on every request.

`recon:generate` automatically copies detected fixtures to
`src/sites/<id>/fixtures/`. To use one in your plugin:

```ts
import { z } from "zod";
import { loadFixture } from "@/scraper/fixtures";

const MarketsSchema = z.array(z.object({ id: z.string(), name: z.string() }));

// Loaded synchronously at module init — zero per-request overhead.
const markets = loadFixture("my-site", "markets.json", MarketsSchema);
```

`loadFixture(siteId, filename, schema)` reads `src/sites/<siteId>/fixtures/<filename>`
synchronously and Zod-parses it. The call throws at startup if the file is missing
or the shape is wrong, so fixture breakage surfaces immediately on deploy rather
than on the first request.

### 3c — Rate-limit probe (run last)

Fires 60 sequential requests (20 per rps level) at 1 → 3 → 5 rps, records `Retry-After` /
`X-RateLimit-*` / Akamai headers, and stops at the first `429` or `403`. The
safe ceiling is written to config.

**Run this last.** If the probe bans the egress IP, everything else is already
captured. Losing access mid-probe is acceptable; losing it mid-recon is not.

---

## Phase 4 — Codify the contract (one human PR)

This is the only phase with meaningful human judgment. The output is
`src/sites/<id>/contract.ts`.

### 4a — Trim the query

`recon-generate` produces an initial `contract.ts` with the captured query inlined verbatim. Review it and strip UI-only fields: your query is what *you* need, not everything the UI requested. Often that's 60% of the fields. Keeping it lean isolates you from UI-driven schema churn — the server only sends what you ask for.

### 4b — Verify load-bearing headers

`recon-generate` derives `BASE_HEADERS` from the request headers the browser actually sent during recon, filtered to those present in every capture whose endpoint replayed successfully. Review the generated set and remove anything decorative — extra headers widen the fingerprint surface that bot-detection systems can exploit. The minimal set (Content-Type, Accept, Origin, Referer, User-Agent) is almost always sufficient.

### 4c — Verify the rate-limit ceiling

`recon-generate` sets the Bottleneck `minTime` from the Phase 3 probe result. Check the generated value against the probe findings in the findings doc (Phase 4e) and adjust if needed. The ceiling prevents the hot path from ever exceeding the safe rps discovered during probing.

### 4d — Review Zod schemas

`recon-generate` infers Zod schemas from the captured JSON bodies. Review any `z.unknown()` fields — these appear where the inferred type was ambiguous — and tighten them to the actual shape you need. These schemas are **runtime drift detectors**: the moment a response stops matching, dispatch() falls back to the browser path and the smoke test fails.

### 4e — Findings document

`pnpm run recon:summarize -- --site-id <id>` writes `docs/<id>-recon.md` — a
human-readable rollup of what the pipeline found: endpoints, which are public,
auth requirements, rate-limit ceilings with ready-to-paste Bottleneck config,
load-bearing headers, hazards (Akamai, Cloudflare), and auxiliary fixtures.
Without `--site-id`, the default output path is `docs/target-recon.md`.

See `docs/target-recon.md` for the format.

### 4f — Generate the plugin skeleton (automated)

```bash
pnpm run recon:generate -- --site-id my-site
```

Reads every artifact from Phases 1–3 and writes a complete plugin to `src/sites/my-site/`:

- `contract.ts` — Zod schemas inferred from captured JSON, load-bearing headers, Bottleneck ceiling, and `executeHttp` / `execute` implementations
- `flows/browser-flow.ts` — Stagehand fallback wired to your `recon-flow.json` steps
- `index.ts` — barrel export
- `fixtures/` — any static JSON found by Phase 3b auxiliary probe, already copied in

After generation: trim UI-only fields from the GraphQL query, narrow any `z.unknown()` entries in the schema you care about, and verify the header set. Pass `--force` to overwrite an existing plugin directory. The generated code is a starting point — review it before registering the plugin.

### 4g — Shared helpers used inside `contract.ts`

Plugins should not write raw `fetch` / `undici` calls. The generated
`contract.ts` wires up two factories — keep them when you edit:

- `createHttpClient(opts)` (`src/scraper/http-client.ts`) — typed fetch
  wrapper with cookie jar, header normalization, response Zod validation, and
  retry-aware error classes (`HttpRateLimitError`, `HttpBotChallengeError`,
  `HttpSchemaError`, `HttpServerError`) that the dispatcher knows how to
  classify.
- `createGraphqlClient(opts)` (`src/scraper/graphql-client.ts`) — same
  conventions for GraphQL endpoints.

Instantiate each at module scope so cookie jars persist across invocations;
call the returned wrapper inside `executeHttp`. Tests should stub the
**wrapper**, not the factory — see `docs/testing.md`.

---

## Phase 5 — Runtime: hot path + fallback

The full dispatch flow lives in `src/plugins/loader.ts` (`dispatch()`).

### 5A — Hot path (preferred)

Direct HTTP — no browser, no LLM tokens, millisecond latency, fractions of a
cent per call.

```
Request arrives
  → LRU cache check (getCachedResponse)         [src/cache/response-cache.ts]
  → cache hit → return immediately
  → cache miss → getOrCreateInFlight(key, fn)   [coalesces concurrent misses]
    → executeHttp(payload, context)              [plugin's hot path]
      → bottleneck.schedule(fetch)              [per-plugin rate limit]
        → p-retry (2 retries on network errors)
        → zod.parse(response)                   [drift detector]
  → record hot-path latency
  → write cache entry
  → write audit row (SiteSubmission)
  → return
```

**Cache deduplication:** `getOrCreateInFlight` coalesces concurrent misses on
the same cache key into a single upstream call. If 10 identical requests arrive
while the first is in-flight, all 10 await the same promise. This prevents
thundering-herd fan-out to the target site on cold-start.

Cache key = `${context.baseUrl}:${plugin.meta.siteId}:<sha256(canonical payload)[:32]>`
(`src/plugins/loader.ts:82-83`). The "endpoint" prefix is the resolved per-site
base URL plus the site ID, so swapping a site's base URL via env naturally
invalidates its cache without any code changes. Object key order and primitive
array order are normalized so `{a:1,b:2}` and `{b:2,a:1}` hit the same entry.
Default TTL: 15 minutes. Configurable via `CACHE_TTL_MS`.

### 5B — Browser fallback (on failure only)

Invoked when the hot path throws `HttpSchemaError`, `HttpBotChallengeError`, or
`HttpServerError`. Slower and more expensive — that's fine, it's rare.

```
Hot path fails (schema mismatch, bot challenge, or 5xx)
  → recordFallbackActivation(siteId)
  → runWithSession(fn)                          [src/scraper/pool.ts]
    → p-queue (bounded concurrency = SESSION_POOL_SIZE)
    → withScraperRetry (up to 3 attempts)       [wraps everything below]
      → createBrowserSession()                  [src/scraper/session.ts]
          → Steel.sessions.create (residential proxy, random viewport)
          → Stagehand.init() via CDP
      → Promise.race([plugin.execute(session), TASK_TIMEOUT_MS (60min default)])
    → session.close() in finally
  → write audit row (SiteSubmission)
  → return
```

**`x-barnacle-force-fallback: true`** — sending this header on the incoming
request bypasses the hot path entirely and goes directly to the browser path.
Useful for debugging or when you know the hot path is broken. (Fastify
lowercases incoming header keys; the dispatcher reads
`request.headers["x-barnacle-force-fallback"]` — supply lowercase to match.)

### 5C — Error classification

`withScraperRetry` (`src/scraper/retry.ts`) applies a policy based on error type:

| Error | Source | Policy |
|-------|--------|--------|
| `CaptchaError` | Stagehand flow | **Abort immediately** — surface to humans, don't burn sessions |
| `EmptyResultsError` | Plugin logic | **Abort** — query-shape bug, not transient |
| `SessionTimeoutError` | Per-task hang ceiling (`TASK_TIMEOUT_MS`, 60min default) | Kill session → create fresh → retry up to `maxAttempts` (restart happens at most once) |
| `SelectorFailureError` | Stagehand can't find element | Retry up to `maxAttempts` (default 3) with exponential backoff |
| `UnknownScraperError` | Unclassified | Retry up to `maxAttempts` |

Concrete settings (`src/scraper/retry.ts`): `factor: 2`, `minTimeout: 500ms`,
`maxTimeout: 5000ms`, `randomize: true`, default `maxAttempts: 3`.
`EmptyResultsError` and abort signals short-circuit retries;
`SessionTimeoutError` triggers a one-time session restart between attempts.

Hot-path error → fallback decision (in `dispatch()`):

| Hot-path error | Triggers browser fallback? | Reason |
|---------------|--------------------------|--------|
| `HttpSchemaError` | **Yes** | Response shape drifted; browser might still work |
| `HttpBotChallengeError` | **Yes** | 401/403 — browser with residential IP may get through |
| `HttpServerError` | **Yes** | 5xx — browser recovery strategy is the same |
| `HttpRateLimitError` | **No** | 429 — burning a Steel session won't help; back off instead |

### 5D — Session pool mechanics

A single `p-queue` with `concurrency = SESSION_POOL_SIZE` (default: 3) prevents
accidental session sprawl. Sessions are created on demand inside each queued
task — not pre-warmed — so Steel billing stays proportional to actual traffic.

The **per-task hang ceiling** (`TASK_TIMEOUT_MS` in `src/scraper/pool.ts`,
60-minute default) prevents a hung Stagehand operation (infinite network wait,
frozen CDP connection) from holding a queue slot indefinitely. It converts a
silent hang into `SessionTimeoutError`, which the retry policy acts on by
tearing down the broken session and starting a fresh one. The default is sized
for long browser flows; shorten per-plugin via `SitePluginMeta.taskTimeoutMs`
when a site's normal latency is well below it. This is a hang-recovery floor,
not a p99 latency budget.

On `SIGTERM` / `SIGINT`, `drainPool()` (`src/scraper/pool.ts`) pauses new intake,
waits up to 20 seconds for in-flight tasks to finish their `finally` blocks and
close Steel sessions, then resolves. Without this, process exit leaves live Steel
sessions billing until their own timeout.

**Viewport rotation** (`src/scraper/session.ts`): each session picks a random
desktop viewport from a fixed set (`1280×720`, `1366×768`, `1440×900`,
`1920×1080`). A fixed pixel size is an easy bot-detection signal; rotating it
makes session fingerprints harder to cluster.

### 5E — Per-site base URL overrides

Any env var matching `BARNACLE_SITE_<UPPERCASE_SITE_ID>_BASE_URL` is collected
into `config.scraper.siteBaseUrls[siteId]` at boot (`src/config.ts:40-46,
119-122`) and passed to the plugin as `context.baseUrl`. Underscores in the
env-key suffix map to hyphens in the looked-up `siteId` (`src/config.ts:124`):

```bash
BARNACLE_SITE_MY_SHOP_BASE_URL=https://staging.my-shop.com
```

overrides the `my-shop` plugin's `defaultBaseUrl` without any source change.
Falls back to `SitePluginMeta.defaultBaseUrl` when the key is absent. Lets you
swing a plugin between staging/prod/replay environments per deployment, and —
because the cache key prefix is `${context.baseUrl}:${siteId}` — staging
traffic never pollutes the production cache.

---

## Phase 6 — Drift detection

### 6A — Nightly smoke test

`src/scripts/smoke-test.ts` runs one request through the hot path end-to-end
and Zod-parses the full response body against the plugin's `responseSchema`. Any
schema violation fails the pipeline immediately — fail fast, fail loud.

```bash
pnpm run smoke -- \
  --site my-site \
  --payload '{"query":"test"}' \
  --host "$SMOKE_HOST" \
  --fallback \
  --response-schema src/sites/my-site/contract.ts

# For plugins that use routeOverride in their meta:
pnpm run smoke -- \
  --site my-site \
  --route /legacy/v2/submit \
  --payload '{"query":"test"}' \
  --host "$SMOKE_HOST"
```

`--response-schema` points to a module whose default export is a Zod schema. The
smoke test validates the *full* response body against it — not just the envelope
shape — so any schema drift on the data payload fails the pipeline immediately.
Client-facing error codes are tabled in `docs/architecture.md`.

`--fallback` additionally runs a second request through the Stagehand browser
path to catch Stagehand cache staleness (the cached selector was for a DOM
structure that no longer exists).

### 6B — Metrics signals (the detection ladder)

`/readyz` exposes per-site drift-detection counters (`src/scraper/metrics.ts`):

```json
{
  "metrics": {
    "my-site": {
      "hotPathSuccess": 4821,
      "fallbackActivations": 3,
      "rateLimitRejections": 0,
      "p95LatencyMs": 187
    }
  }
}
```

The detection ladder — ordered by how early each signal fires:

1. **Smoke test fails.** Runs nightly (or per deploy). Zod-parses a real
   response. Fails fast, fails loud.
2. **`fallbackActivations` spikes.** The hot path starts dying; fallback
   absorbs traffic. Error rate stays low but cost rises. Dashboard warns you
   before users notice.
3. **`p95LatencyMs` spikes.** Fallbacks are 10–100× slower than the hot path.
   p95 doubling overnight means something shifted.
4. **`rateLimitRejections` appear.** The site lowered its ceiling, or your IP
   is being throttled. Your Bottleneck config is now wrong.
5. **Customer-reported — dead last.** If this is how you find out, drift
   detection failed.

### 6C — Maintenance loop

```
Smoke test fails (nightly, automated)
  → Re-run recon:browser      → fresh /tmp/recon/graphql/*.json
  → Re-run recon:http         → fresh /tmp/recon/replays/
  → Human reviews diff:       captured shape vs. contract.ts
  → Update query / headers / Zod schema / throttle config
  → Re-run recon:summarize    → updated docs/target-recon.md
  → Ship PR
  → Smoke test reruns         → green? done.
```

Human involvement = one diff review + a small PR. All detection and execution is
automated.

### 6D — Heal-loop workflow

When a smoke test fails *and* the failure is a recon flow step error (the browser
couldn't find an element or a step timed out after all four cascade attempts), the
automated maintenance loop in §6C won't help — you don't need a schema update, you
need a better flow instruction. The heal loop handles this case.

**Step 1 — Run the heal loop**

```bash
pnpm tsx src/scripts/recon-heal.ts \
  --site-id <id> \
  --url https://<target-site.example.com>
```

The loop runs a baseline replay of `src/sites/<id>/recon-flow.json`, measures which
steps fail, then iterates: propose a minimal patch to one failing step, replay the
patched flow, score, repeat. Defaults: 5 iterations, 3 replays per arm,
success threshold 0.9. Add `--dry-run` to stub the browser runner in CI.

**Step 2 — Review the report**

When the loop finishes it writes:

```
heal-out/<id>/healing-<id>.md   ← verdict, best patch, iteration table
heal-out/<id>/state.json        ← full convergence history
heal-out/<id>/iter-N/           ← per-iteration patch-request, patch-response, scores
```

Open `heal-out/<id>/healing-<id>.md`. It shows:

- **Verdict**: `SUCCESS` / `PLATEAUED` / `BUDGET_EXHAUSTED` / `REGRESSED`
- **Best patch**: the `anchor` (verbatim substring of the failing step) and its
  `replacement` (the new instruction text)
- **Iteration table**: pass-rate delta per iteration

The `/readyz` endpoint surfaces the latest verdict per site in the `heal` field:

```json
{
  "heal": {
    "my-site": { "verdict": "SUCCESS", "bestPassRate": 0.95, "reportPath": "heal-out/my-site/healing-my-site.md" }
  }
}
```

**Step 3 — Manually apply the patch**

The heal loop never modifies `src/sites/<id>/recon-flow.json` — the operator owns
the source of truth. After reviewing the report, open the flow file and apply the
patch by hand:

```bash
# The report gives you: anchor="<old text>" replacement="<new text>"
# Find the matching step in src/sites/<id>/recon-flow.json and substitute.
$EDITOR src/sites/<id>/recon-flow.json
```

Then re-run the smoke test to confirm:

```bash
pnpm run smoke -- --site <id> --payload '{"query":"test"}' --host "$SMOKE_HOST"
```

**The manual-apply discipline** — prompts and flow instructions stay under human
control; the loop proposes patches backed by measured evidence (replay pass rates)
rather than modifying the source directly. This mirrors the pila self-healing
principle: the tool produces evidence, the human applies judgment. A patch that
improved the pass rate in the heal environment still needs human review before it
ships to `main` — the operator is the last verifier, not the loop.

---

## What changes, how you find out, how fast you fix it

### Change severity

| Severity | What changed | Symptom |
|----------|-------------|---------|
| **Low** | Response field added or renamed | Zod schemas start failing; existing consumers may be unaffected |
| **Medium** | Query shape required by server changes | A field you request is now rejected, or a new required argument appears — hot path 4xx on every call |
| **High** | Endpoint path or host moves | `404` on every call |
| **High** | Bot detection tightens | `403` on plain `fetch()`. Endpoint still exists, direct HTTP is dead |
| **Severe** | Auth requirements appear | What was public now requires a session token. Direct HTTP dead until auth flow is resolved |

### The fix ladder

| Severity | Response | Time-to-fix |
|----------|----------|-------------|
| Schema drift | Update Zod schema; re-deploy. Fallback covers the gap. | < 1 hour |
| Query shape rejected | Re-run Phase 1 against the broken operation. Diff old vs. new capture. Update codified query. | < 4 hours |
| Endpoint moved | Re-run Phase 1 fully — the whole flow is likely restructured. Re-do Phases 2–4. | 1 day |
| Bot detection tightened | Recon still works (real browser). Flip to fallback-only while you investigate whether new headers restore direct HTTP. | Minutes to flip; days to restore |
| Auth appeared | Strategy decision: capture-and-refresh auth token via browser, or accept Stagehand-only for affected endpoints. | Days to weeks |

### What protects you before the change is visible

**Zod at the boundary.** The moment a response stops matching your schema, the
request fails loudly rather than silently returning garbage. Single most
important defensive measure.

**Stagehand fallback is always hot.** You don't have to build a fallback when
the hot path dies — it already exists. Site changes degrade cost and latency,
not availability.

**Recon-time self-healing.** When a recon flow step misses, recon-browser does
not give up. Each step runs through a 4-attempt cascade (act → observe+act →
observe+act with `ignoreSelectors` → Anthropic-SDK rephrase), verified by
network-counter delta or URL change. On terminal cascade failure the script's
`main()` loop also attempts up to two global flow replans, where Claude
rewrites the remaining flow tail given the failure context. The aim is that a
single recon run produces a working capture set even when the user's
flow text was rough — see Phase 1c–1e above for the full design. Note: we
intentionally set `selfHeal: false` on Stagehand. Stagehand's built-in heal
only catches Playwright throws, not silent semantic misses ("clicked the wrong
button, returned success"), which is the failure mode we actually need to
recover from. The cascade handles both.

**Runtime fallback retries the whole flow.** The runtime path is different:
when the hot HTTP path throws a schema/bot-challenge/5xx error the dispatch
layer falls back to the browser, and the entire `plugin.execute()` is wrapped
in `withScraperRetry` (`src/scraper/retry.ts`) — 3 attempts, exponential
backoff, classified by error type. The verifier at runtime is the plugin's
Zod schema: if extraction returns garbage, parse fails, the whole flow
restarts with a fresh selector cache. Coarse-grained but correct, and fits
the runtime cost model where the right answer to a hot fallback rate is to
re-run recon.

**Committed artifacts make the diff trivial.** `git log` on the captured query
tells you exactly when the target's shape last changed. You're never guessing
what changed or when.

---

## Why this approach wins

### Alternatives compared

| Approach | Cost/req | Latency | Fragile to UI | Fragile to API | Handles auth | Effort |
|----------|----------|---------|---------------|----------------|--------------|--------|
| Browser on every call | High | High | Medium | Low | Yes | Low |
| HTML screen scraper | Low | Low | **High** | Low | Yes | Medium |
| Manual DevTools recon | Low | Low | Low | High (human redo) | Yes | **High (ongoing)** |
| Official partner API | — | — | — | — | Depends | Often unavailable |
| HAR replay | Low | Low | Medium | **High** | Limited | Medium |
| Direct HTTP from scratch | Low | Low | Low | **High** | Hard | Impossible-to-high |
| **Recon → codify → direct HTTP + fallback (this)** | **Low** | **Low** | **Low** | Low (re-runnable) | Yes (via fallback) | Medium, front-loaded |

**Front-loaded recon work buys an integration as cheap as "direct HTTP from
scratch," as robust as "browser on every call," and maintainable in a way none
of the hand-rolled options are.**

### Why not the alternatives

**Browser on every call** — what Barnacle uses as *fallback only*, after direct
HTTP has been proven sufficient. Cost: Steel minutes + Anthropic tokens on every
production call, orders of magnitude more expensive at scale. Latency: 5–15
seconds per request (browser cold-start + navigation + LLM inference).

**HTML screen scraper** — scraping HTML is scraping the wrong layer. The API the
SPA calls carries richer, better-structured data. CSS selectors break on every
UI redesign, which happens far more often than the API changes.

**Manual DevTools recon** — same approach as Phase 1, but slow, not committed,
and not re-runnable. Human DevTools re-runs cost hours when the site changes;
`recon:browser` reruns unattended (~20–40 min for a typical flow). Auto-captured
results are diffable against prior runs; human memory is not.

**HAR replay** — misses the AI piece. A HAR is a static snapshot of one
session. If your flow requires conditional clicks, you need AI navigation, not a
replay tool. Also misses codification: HAR replay ships the whole recording to
production; Barnacle ships only the trimmed, committed query.

**Direct HTTP from scratch** — right runtime destination, wrong starting point.
You'd have to guess query shape, headers, rate limits, and filter encoding
without ever seeing a real request. Dead end for anything non-trivial. The
browser is the oracle: Phase 1 uses it to *learn* what to send. After that,
yes — direct HTTP.

---

## Elevator pitch

We don't hand-write integrations against partner websites. We point an
AI-driven browser — Stagehand on a Steel cloud browser — at the site and have
it click through a normal user flow while a response listener wiretaps every
network call to disk. Then a separate script replays those captured requests from
plain Node `fetch()` — no browser, no AI — to prove the endpoints work
standalone. Once that passes, a generator script turns the captures into a
complete plugin — Zod schemas, headers, rate-limit ceiling, and both the
hot-path HTTP client and Stagehand fallback. The developer reviews, trims, and
ships it as a PR. The runtime hot path then hits the real API directly: fast,
cheap, deterministic. The AI browser only re-engages as a fallback if that path breaks.
A nightly smoke test tells us the moment a contract drifts, and the whole recon
script is re-runnable — that's our maintenance loop.

**Four verifications:**
- `pnpm run smoke` — exercises the direct-HTTP hot path end-to-end
- Open `/tmp/recon/graphql/*.json` after a recon run — these are real captures
- Diff `src/sites/<id>/contract.ts` against `/tmp/recon/graphql/*<operationName>*.json` — the committed query should be a lean subset of the captured one (trim any UI-only fields)
- `docs/target-recon.md` is the human rollup from Phase 4e

---

## Barnacle file map

| Concern | File |
|---------|------|
| Session bootstrap | `src/scraper/session.ts` |
| Session pool + timeout | `src/scraper/pool.ts` |
| Retry policy | `src/scraper/retry.ts` |
| Hot-path HTTP client | `src/scraper/http-client.ts` |
| GraphQL client | `src/scraper/graphql-client.ts` |
| Per-plugin rate limiting | `src/scraper/throttle.ts` |
| Scraper error hierarchy | `src/scraper/errors.ts` |
| Static fixture loader | `src/scraper/fixtures.ts` |
| Dispatch (hot path → fallback) | `src/plugins/loader.ts` |
| Response cache + coalescing | `src/cache/response-cache.ts` |
| Drift-detection metrics | `src/scraper/metrics.ts` |
| Plugin contract interface | `src/site-plugin.ts` |
| Phase 1 — browser recon | `src/scripts/recon-browser.ts` |
| Phase 2–3 — HTTP replay + probes | `src/scripts/recon-http.ts` |
| Phase 4f — plugin skeleton generator | `src/scripts/recon-generate.ts` |
| Phase 4e — findings doc generator | `src/scripts/recon-summarize.ts` |
| Shared recon types + utilities | `src/scripts/recon-shared.ts` |
| Smoke test | `src/scripts/smoke-test.ts` |
| Findings doc (generated) | `docs/target-recon.md` |
