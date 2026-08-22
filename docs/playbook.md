# Barnacle Recon Playbook

> Turn a website into an API. Recon, replay, and drift detection are scripted;
> you write the flow once and review a PR when the site changes. See
> [README.md](../README.md#how-it-works) for the mental model and pipeline
> overview — this doc is the operator runbook, phase by phase.

---

## Phase 0 — Define the user flow

The only human-authored input to the pipeline. Write the narrowest sequence of
user actions whose data you care about, as a JSON array of natural-language
instructions, and commit it:

```
src/sites/<id>/recon-flow.json
```

```json
["click the Electronics category filter", "open the first product result"]
```

Aim for the narrowest flow that triggers the network calls you need — more
steps means more captures and more noise.

**Pure GET-style SPAs:** if the target fetches everything on initial page
load, skip the flow entirely — run `recon:browser --url X` with neither
`--flow` nor `--flow-file`; the script captures whatever fires during
navigation.

**Ad-heavy commercial sites:** analytics/session-replay beacons fire on
timers, so `networkidle` never resolves. The initial `goto` waits for
`domcontentloaded` instead and proceeds if even that doesn't settle. Set
`RECON_GOTO_WAIT_UNTIL` (`load` | `domcontentloaded` | `networkidle`) if a
site needs a stricter wait.

**Read-only sites:** omit `submitStep`/`submitEndpointPattern` from the flow
file. Steps must still *act* on something — "wait for results to load" has no
action and the healing cascade will report it as impossible.

**Cross-origin iframe targets:** some integrations embed their form in a
cross-origin `<iframe>` rather than navigating the top window. A flow whose
targets live inside such a frame must declare `frameSelector`:

```json
{
  "steps": ["click the Apply button", "fill the First Name field with {{ .request.FirstName }}"],
  "frameSelector": "iframe#apply_frame"
}
```

The same field is available on a config-plugin manifest's `spec.flow` (see
`examples/plugins/acme-jobs.plugin.json`).

`frameSelector` must be the bare CSS selector of the `<iframe>` element
itself — never a Stagehand `>>` hop string. `resolveFrameTarget`
(`src/scraper/frame-target.ts`) resolves the frame boundary from that
selector and composes the hop internally; passing a pre-composed hop breaks
resolution and throws rather than silently degrading to the main frame.
Omitting `frameSelector` preserves default behavior (drive the main frame).

**Human-readable name:** the object form also accepts `displayName`, the flow
author's real label for the plugin (never derived by capitalizing `siteId`).
It round-trips losslessly through replan write-back, and `recon:generate`
threads it verbatim into both emit paths' `meta.displayName` /
`metadata.displayName` when present, leaving it unset otherwise.

`observe()` cannot see into a cross-origin OOPIF at all — every scoping form
returns zero candidates even though the frame is attached. For a frame-scoped
step, the cascade falls back to `page.deepLocator()` whenever `observe()`
comes back empty.

**Frame-attach timing:** a racy OOPIF can still be mid-attach when a step
enters the cascade. `resolveFrameTarget` polls up to `FRAME_READY_TIMEOUT_MS`
(20s default) before falling back to the main frame, re-resolving before each
candidate probe so a frame attaching mid-step is still reached. See
[Environment variables](./configuration.md#environment-variables) for the
related `FRAME_*_TIMEOUT_MS` settings.

---

## Phase 1 — Browser recon (`recon-browser.ts`)

```bash
pnpm run recon:browser -- \
  --url https://example.com \
  --flow-file src/sites/my-site/recon-flow.json
```

Total runtime: 20–40 minutes for a typical flow, fully unattended.

### 1a — Session bootstrap

`createBrowserSession()` (`src/scraper/session.ts`) constructs Stagehand with
`serverCache: true` (skips LLM inference on replay after the first run) and
`selfHeal: false` — Stagehand's built-in heal only catches Playwright throws,
not silent semantic misses ("clicked the wrong thing, returned success"),
which recon's own verify-and-retry cascade handles (1c). The runtime fallback
uses a separate whole-flow retry via `withScraperRetry`
(`src/scraper/retry.ts`), verified by Zod.

This factory is shared with the runtime dispatch path (`src/plugins/loader.ts`
— 5B/5D), so every Browserbase-backed session also exposes a memoized
`getOutboundIp()` (absent on Steel) — one extra tab load to an IP-echo
endpoint, bounded by `SCRAPER_SESSION_IP_TIMEOUT_MS` (~10s default), gated by
`SCRAPER_CAPTURE_SESSION_IP` (default `true`). Recon-browser never calls it —
it exists for the dispatch path's per-submission telemetry (5D).

### 1b — CDP session-level network capture

A single listener attaches to the page's main CDP session and pairs
`Network.requestWillBeSent` / `responseReceived` / `loadingFinished` by
`requestId`, so a response body is fetched only once fully received. There is
no URL-shape filter — every response is captured, including early ones during
navigation. Grep `<run-dir>/graphql/` for specific endpoints.

Each capture records, untruncated: timestamp, method, URL, status, request
headers and post body, response headers and body, `operationName`/`query`/
`variables` (parsed from GraphQL POST bodies), and a phase tag.

### 1c — Self-healing cascade

Each flow step runs through `executeStepWithHealing`
(`src/scraper/flow-runner.ts`), a 5-attempt escalating cascade. We stop the
moment an attempt is verified successful; the verifier is "did the network
counter advance OR did the URL change":

```
flow step "X"
  ├── 1: act(X)                                    → verify
  ├── 2: observe(X) → act(topAction)                → verify
  ├── 3: structured-click resolution                → verify
  ├── 4: observe(X, { ignoreSelectors: tried }) → act → verify
  ├── 5: LLM rephrase(X, ...) → act(rephrased)       → verify
  └── all exhausted → dumpStepFailure() + throw StepVerificationError
```

**Phantom-click escalation:** if attempt 1 reports success but pre/post
snapshots show zero network delta, zero URL change, and no DOM growth,
`classifyPhantomClick` (`src/scraper/phantom-click.ts`) marks it `"phantom"`
— Stagehand clicked nothing real (typically a submit control inside a shadow
root). On a submit-shaped step, attempt 2 reroutes to
`deep-submit-locator` (`src/scraper/submit-control.ts`), ranking every
submit-shaped candidate via deep DOM traversal (including shadow roots) and
clicking the top-ranked one directly. Non-submit steps are unaffected — the
deep submit-control locator would be a guaranteed no-op there.

**Deep-locator candidate walk (frame-scoped steps):** when `observe()` is
blind to a cross-origin OOPIF, candidates resolve via `page.deepLocator()`
(`src/scraper/deep-locator-candidates.ts`), scoped first to
`INTERACTIVE_CANDIDATE_SELECTOR`, widening once to `"*"` if nothing matches.
A fill/select step recovers its target field label (e.g. "First Name")
separately from the value via `parseFillStep`/`parseSelectStep`, matched
against a candidate's accessible name — this exists because ranking by
quoted phrases alone ties every candidate at score 0 for a step like "Fill in
the First Name field with 'Reginald'" (only `'Reginald'` is quoted), so DOM
order would pick whatever sits first. A field-label match routes to
`fillDeepLocatorCandidate`/`selectDeepLocatorCandidateOption`
(`src/scraper/deep-locator-actuate.ts`), which reads the write back to
confirm — the only verification signal available for a `deeplocator=`
selector. No candidate naming the field is a refusal, not a guess.

Everything else falls to `clickFirstActionableCandidate`
(`src/scraper/deep-locator-click.ts`), which walks ranked candidates and
actuates the first that succeeds; a CDP `-32000 Node does not have a layout
object` error costs only that candidate. A select step with no quoted field
label refuses outright on a tie rather than guessing the wrong screening
question.

Backoff between attempts: linear `attempt * 1000ms`.

### 1d — Step failure dump

When the cascade exhausts, the executor writes a diagnostic bundle to
`<run-dir>/step-failures/<NNN>-<phase>.json` (timestamp, step, page state,
every attempt's technique/selectors/result, final `observe()` output, and the
last 5 capture filenames) and throws `StepVerificationError`
(`src/scraper/errors.ts`). This is what you read to fix the flow. The
`.claude/agents/recon-flow-patch-generator` subagent automates the analysis,
returning a minimal `{anchor, replacement}` patch verified mechanically
before it's applied.

For repeated/intermittent failures, `pnpm run recon:heal -- --site-id <id>
--url <url>` runs the full baseline → patch → replay → convergence loop
automatically and writes `heal-out/<id>/healing-<id>.md` with the verdict and
best patch for manual review. The source `recon-flow.json` is never modified.

### 1e — Global replan loop

When `StepVerificationError` reaches `main()`, it triggers a global replan
rather than failing: Claude rewrites the remaining flow tail given the
failure context, capped at `MAX_REPLANS = 2` per run. Inputs: the original
flow, completed steps (held fixed), the failed step, remaining steps, current
page URL/title, `observe()` candidates, and the failure dump path. Output is
a strict JSON array of 1–20 instruction strings; `IMPOSSIBLE` or an unparsable
response rethrows the original error. A successful replan writes a sibling
`<run-dir>/step-failures/<NNN>-<phase>.replan.json` audit record, splices the
new tail into the live plan, and resumes. The `--flow-file` on disk is never
modified.

### 1f — Per-call capture files

Each captured response is written to its own numbered file, e.g.
`<run-dir>/graphql/000-home-productSearch_Products.json` — one file per call
keeps captures diffable, so `git diff` between two recon runs shows exactly
which operations changed shape.

### 1g — Parameter decoding

Opaque POST body parameters are decoded automatically (JSON → URL-encoded →
base64) and saved alongside the capture, for sites that double-encode filter
state into query strings.

---

## Phase 2 — HTTP replay (`recon-http.ts`)

```bash
pnpm run recon:http
```

Answers the pivotal question: does the server care that a real browser sent
the request, or will it answer anyone who sends the right bytes? No
Stagehand, no Steel, no Playwright — the script walks `<run-dir>/graphql/*.json`,
deduplicates by `url|operationName|variables`, and reissues each capture via
Node's `fetch()`.

**Start minimal.** Replay uses only the load-bearing header subset
(`Content-Type`, `Accept`, `Origin`, `Referer`, `User-Agent`). Cookies and
auth tokens are almost always unnecessary on public endpoints — adding them
makes it harder to isolate which headers actually matter. If a replay fails,
add headers one at a time; the one that fixes it was load-bearing.

Each replay is saved to `<run-dir>/replays/` with status, headers, body, and
a link back to the source capture. Every replay returning 200 with a matching
shape proves the browser is unnecessary for production.

### Interpreting replay failures

| Symptom | Likely cause | Response |
|---------|-------------|----------|
| `403` on every replay | Browser fingerprinting / bot manager | Add more headers; if still `403`, accept Stagehand-only production |
| `401` on every replay | Session auth required | Capture the token, determine its lifetime, build a refresh strategy |
| `200` but empty body | Missing `Origin` / `Referer` | Add them and retry immediately |
| `200` on home, `500` on detail | Detail query references a session variable | Diff working/failing replay headers; likely a CSRF token |
| Replay passes sporadically | Rate limit already triggered from recon | Pause, switch IP, reduce rps ceiling |
| Replays fine for a week, then fail | Target site changed schema | Re-run Phases 1–4, diff captures, ship the delta |

---

## Phase 3 — Edge probing (`recon-http.ts`, still automated)

Runs together with Phase 2 in the same script invocation.

### 3a — GraphQL introspection

Sends `{ __schema { types { name } } }` to each unique GraphQL endpoint. If
enabled, the full schema is dumped for reviewing the inferred Zod types. If
disabled, `recon-generate` infers Zod schemas directly from captured JSON.

### 3b — Auxiliary fixture detection

Finds static JSON endpoints in the captures (markets, currencies, labels),
downloads them, and flags them as fixtures — a response that changes rarely
enough to bake into the codebase and load at startup via
`src/scraper/fixtures.ts` rather than re-fetching per request.

Each fixture is written with a provenance record in
`<run-dir>/aux/aux-manifest.json`. `recon:generate` only copies a fixture to
`src/sites/<id>/fixtures/` when its manifested hostname is an own-backend
host (matches the flow's declared `ownBackendHostnames`, or the site's own
registrable domain). A file in `aux/` with no manifest entry is excluded
rather than assumed safe.

```ts
import { z } from "zod";
import { loadFixture } from "@/scraper/fixtures";

const MarketsSchema = z.array(z.object({ id: z.string(), name: z.string() }));
const markets = loadFixture("my-site", "markets.json", MarketsSchema);
```

`loadFixture` reads and Zod-parses synchronously at module init, throwing at
startup if the file is missing or malformed — breakage surfaces on deploy,
not on the first request.

### 3c — Rate-limit probe (run last)

Fires 60 sequential requests (20 per rps level) at 1 → 3 → 5 rps, records
`Retry-After` / `X-RateLimit-*` / Akamai headers, and stops at the first
`429` or `403`. The safe ceiling is written to config. **Run this last** —
if the probe bans the egress IP, everything else is already captured.

---

## Phase 4 — Codify the contract (one human PR)

The only phase with meaningful human judgment. Output: `src/sites/<id>/contract.ts`.

- **4a — Trim the query.** `recon-generate` inlines the captured query
  verbatim. Strip UI-only fields — often 60% of them — to isolate yourself
  from UI-driven schema churn.
- **4b — Verify load-bearing headers.** `recon-generate` derives
  `BASE_HEADERS` from headers present in every successfully-replayed capture.
  Remove anything decorative; extra headers widen the bot-detection
  fingerprint surface.
- **4c — Verify the rate-limit ceiling.** `recon-generate` sets Bottleneck's
  `minTime` from the Phase 3c probe. Check it against the findings doc (4e).
- **4d — Review Zod schemas.** Tighten any `z.unknown()` fields — these are
  runtime drift detectors; the moment a response stops matching, `dispatch()`
  falls back to the browser and the smoke test fails.
- **4e — Findings document.** `pnpm run recon:summarize -- --site-id <id>`
  writes `docs/<id>-recon.md` (endpoints, auth, rate limits, headers, hazards,
  fixtures). Default output without `--site-id` is `docs/target-recon.md` —
  see that file for the format.
- **4f — Generate the plugin skeleton (automated).**

  ```bash
  pnpm run recon:generate -- --site-id my-site
  ```

  Writes `src/sites/my-site/{contract.ts, flows/browser-flow.ts, index.ts,
  fixtures/}` from Phases 1–3 artifacts. Pass `--force` to overwrite. Review
  the generated code before registering the plugin.
- **4g — Shared helpers.** Plugins should not write raw `fetch`/`undici`
  calls. Use `createHttpClient(opts)` (`src/scraper/http-client.ts`) and
  `createGraphqlClient(opts)` (`src/scraper/graphql-client.ts`) — typed
  wrappers with header normalization, response-header/cookie binding, Zod
  validation, and retry-aware error classes. Instantiate at module scope so
  bound values persist across calls. Tests stub the wrapper, not the factory
  — see `docs/testing.md`.

---

## Phase 5 — Runtime: hot path + fallback

The full dispatch flow lives in `src/plugins/loader.ts` (`dispatch()`).

### 5A — Hot path (preferred)

Direct HTTP — no browser, no LLM tokens, millisecond latency:

```
Request → plugin.extractJoinKeys(payload) → LRU cache check
  → hit → return
  → miss → getOrCreateInFlight(key, fn) [coalesces concurrent misses]
    → executeHttp(payload, context)
      → bottleneck.schedule(fetch) → p-retry (2x on network errors) → zod.parse(response)
  → merge telemetry over joinKeys, stamp session (null on hot path)
  → emit submission envelope (NDJSON) → fire beacon-fire click (background) → return
```

**Beacon-fire (conversion tracking):** for a plugin that has NOT declared
`extractJoinKeys`, `dispatch()` fires `fireTrackingClick`
(`src/lib/tracking-click.ts`) unawaited after the response returns: it opens
a short-lived Browserbase session, navigates to the plugin's `TrackingUrl`
(30s timeout), waits 5s, then writes a `"beacon"` reconciliation record
(`fired`/`failed`; errors are swallowed and logged at `warn`). A plugin that
declared `extractJoinKeys` (asserting it fires its own tracking nav) instead
gets a synchronous `beaconStatus: "skipped"` record — unless it calls
`context.recordBeaconOutcome(...)` itself once it knows how its nav resolved,
which outranks the automatic `skipped` line for the same `requestId`. Full
field detail: [Fields every reconciliation row
carries](./submission-reconciliation.md#fields-every-reconciliation-row-carries).
This durable record exists because a submission can succeed while the beacon
never fires.

**Cache deduplication:** `getOrCreateInFlight` coalesces concurrent misses on
the same key into a single origin call, preventing thundering-herd fan-out on
cold start. Cache key: `${context.baseUrl}:${plugin.meta.siteId}:<sha256(canonical
payload)[:32]>` (`src/plugins/loader.ts:82-83`) — swapping a site's base URL
via env naturally invalidates its cache. Object key order and primitive array
order are normalized. Default TTL 15 minutes, via `CACHE_TTL_MS`.

### 5B — Browser fallback (on failure only)

Invoked when the hot path throws `HttpSchemaError`, `HttpBotChallengeError`,
or `HttpServerError`:

```
Hot path fails → recordFallbackActivation(siteId)
  → runWithSession(fn) [p-queue, concurrency = SESSION_POOL_SIZE]
    → withScraperRetry (up to 3 attempts)
      → createBrowserSession() → Browserbase.sessions.create (default; Steel is the opt-in fallback via SCRAPER_PROVIDER=steel)
      → fn(session): Promise.race([plugin.execute(session), TASK_TIMEOUT_MS])
      → finally: session.getOutboundIp?.() → context.telemetry.recordSession(...)
    → session.close() in finally
  → [same tail as 5A: merge telemetry, emit envelope, fire beacon, return]
```

`emitEnvelopeSafely` and `fireTrackingClick` live in `dispatch()` itself, so
both paths converge on the identical sequence once a result comes back.

**`x-barnacle-execution: browser`** on the incoming request bypasses the hot
path entirely (lowercase header key — Fastify lowercases incoming headers).

### 5C — Error classification

| Error | Source | Policy |
|-------|--------|--------|
| `CaptchaError` | Stagehand flow | Abort immediately — surface to humans |
| `EmptyResultsError` | Plugin logic | Abort — query-shape bug, not transient |
| `SessionTimeoutError` | `TASK_TIMEOUT_MS` (60min default) | Kill session → fresh → retry (restart before every retry) |
| `SelectorFailureError` | Stagehand can't find element | Retry up to `maxAttempts` (default 3), exponential backoff |
| `UnknownScraperError` | Unclassified | Retry up to `maxAttempts` |

Concrete retry settings (`src/scraper/retry.ts`): `factor: 2`, `minTimeout:
500ms`, `maxTimeout: 5000ms`, `randomize: true`. Override per-plugin via
`SitePluginMeta.maxAttempts`.

Hot-path error → fallback decision: `HttpSchemaError`, `HttpBotChallengeError`,
and `HttpServerError` all trigger the browser fallback (schema drift/bot
block/5xx may resolve with a real browser). `HttpRateLimitError` does not —
burning a session on a 429 won't help; back off instead.

### 5D — Session pool mechanics

A single `p-queue` (`concurrency = SESSION_POOL_SIZE`, default 3) prevents
session sprawl; sessions are created on demand, not pre-warmed, so provider
billing stays proportional to traffic.

The per-task hang ceiling (`TASK_TIMEOUT_MS` in `src/scraper/pool.ts`,
60-minute default) converts a hung Stagehand operation into
`SessionTimeoutError` rather than holding a queue slot forever. Shorten it
per-plugin via `SitePluginMeta.taskTimeoutMs`. Below that floor, every
individual deepLocator/frame-evaluate await is itself bounded by
`withWatchdog` (`src/scraper/watchdog.ts`) against `STEP_WATCHDOG_MS` (2min
default) or the relevant `config.scraper.frame*TimeoutMs` budget.

On `SIGTERM`/`SIGINT`, `drainPool()` pauses new intake and waits up to 20s
for in-flight tasks to close their provider sessions before resolving.

**Viewport rotation:** each session picks a random desktop viewport from a
fixed set, since a static size is an easy bot-detection signal.

**Outbound-IP capture** (`src/scraper/session-browserbase.ts`, gated by
`SCRAPER_CAPTURE_SESSION_IP`, default `true`): since Browserbase never exposes
a session's outbound IP directly, `getOutboundIp()` has the session navigate a
separate tab to an IP-echo endpoint and reads the response back, memoized,
Browserbase-only. Bounded by `SCRAPER_SESSION_IP_TIMEOUT_MS` (~10s default);
runs in a `finally` after `plugin.execute()` resolves, before `pool.ts` closes
the session.

### 5E — Per-site base URL overrides

Any env var matching `BARNACLE_SITE_<UPPERCASE_SITE_ID>_BASE_URL` is collected
into `config.scraper.siteBaseUrls[siteId]` at boot (`src/config.ts:40-46,
119-122`) and passed as `context.baseUrl`; underscores in the suffix map to
hyphens in the `siteId`:

```bash
BARNACLE_SITE_MY_SHOP_BASE_URL=https://staging.my-shop.com
```

overrides `my-shop`'s `defaultBaseUrl` with no source change (falls back to
`SitePluginMeta.defaultBaseUrl` when unset). Because the cache key prefix is
`${context.baseUrl}:${siteId}`, staging traffic never pollutes the production
cache.

---

## Phase 6 — Drift detection

### 6A — Nightly smoke test

`src/scripts/smoke-test.ts` runs one request through the hot path end-to-end
and Zod-parses the full response body against the plugin's `responseSchema`
— any violation fails the pipeline immediately.

```bash
pnpm run smoke -- \
  --site my-site \
  --payload '{"query":"test"}' \
  --host "$SMOKE_HOST" \
  --fallback \
  --response-schema src/sites/my-site/contract.ts
```

`--response-schema` points to a module whose default export is a Zod schema,
validated against the full response body, not just the envelope. Client-facing
error codes are tabled in `docs/architecture.md`. `--fallback` additionally
runs a second request through the Stagehand browser path to catch selector
cache staleness.

### 6B — Metrics signals (the detection ladder)

`/readyz` exposes per-site counters (`src/scraper/metrics.ts`):
`hotPathSuccess`, `fallbackActivations`, `rateLimitRejections`, `p95LatencyMs`.

Ordered by how early each signal fires:

1. **Smoke test fails** — nightly, Zod-parses a real response.
2. **`fallbackActivations` spikes** — hot path dying; error rate stays low
   but cost rises.
3. **`p95LatencyMs` spikes** — fallbacks are 10–100× slower than the hot
   path.
4. **`rateLimitRejections` appear** — the site lowered its ceiling, or your
   IP is throttled.
5. **`tracking_click.failure` rises** (Datadog, tagged `site`/`error_type`,
   emitted by `recordTrackingClickFailure`) — the only signal for "submitted
   but the beacon didn't fire." A graceful shutdown is a real not-fired path
   too: `drainTrackingClicks` gives in-flight clicks only its own timeout
   (default 20s) before `onClose` proceeds.
6. **Customer-reported** — dead last. If this is how you find out, drift
   detection failed.

### 6C — Maintenance loop

```
Smoke test fails (nightly) → re-run recon:browser → re-run recon:http
  → human reviews diff (captured shape vs. contract.ts)
  → update query / headers / Zod schema / throttle config
  → re-run recon:summarize → ship PR → smoke test reruns green
```

Human involvement is one diff review and a small PR; detection and execution
are automated.

### 6D — Heal-loop workflow

When a smoke test fails because a recon flow step errored (element not found,
or timeout after all four cascade attempts) rather than a schema mismatch,
§6C doesn't help — you need a better flow instruction, not a schema update.

```bash
pnpm tsx src/scripts/recon-heal.ts --site-id <id> --url https://<target-site.example.com>
```

Runs a baseline replay of `recon-flow.json`, then iterates: propose a minimal
patch to a failing step, replay, score, repeat (defaults: 5 iterations, 3
replays per arm, success threshold 0.9; `--dry-run` stubs the browser runner
for CI). Writes `heal-out/<id>/healing-<id>.md` (verdict, best patch,
iteration table) and `heal-out/<id>/state.json`. Verdicts: `SUCCESS` /
`PLATEAUED` / `BUDGET_EXHAUSTED` / `REGRESSED`. `/readyz` surfaces the latest
verdict per site under `heal`.

The heal loop never modifies `recon-flow.json` — apply the reported
`{anchor, replacement}` patch by hand, then re-run the smoke test to confirm.

**The manual-apply discipline:** flow instructions stay under human control;
the loop proposes patches backed by measured replay evidence rather than
modifying the source directly. A patch that improved the pass rate in the
heal environment still needs human review before it ships to `main`.

> LLM prompt self-healing is a separate mechanism from recon-flow
> self-healing: `recon:heal` (above) heals natural-language flow steps in
> `recon-flow.json`; `heal:llm` (below) heals the TypeScript prompt templates
> used by LLM call sites. See
> [docs/telemetry-and-judging.md](./telemetry-and-judging.md) for the judging
> rubric.

### 6E — LLM judging and prompt self-healing

> See [docs/telemetry-and-judging.md](./telemetry-and-judging.md) for the
> conceptual background. This section is the operator runbook.

Barnacle captures every LLM call to `.barnacle/calls.ndjson` during recon and
heal runs.

**Step 1 — Judge:**

```bash
pnpm run judge:llm -- \
  --calls-ndjson .barnacle/calls.ndjson \
  --call-type <recon-rephrase|recon-replan|recon-flow-patch|llm-prompt-patch> \
  [--batch-index <N>] [--judge-model <model>] [--out-dir judge-out] [--dry-run]
```

Zero samples for a call type exits cleanly, not an error. `--dry-run` stubs
the scorer deterministically for CI.

**Step 2 — Read the verdict** at `judge-out/verdict-<callType>-<batchIndex>.json`.
The `aggregate` block reports pass rate per dimension: `schemaPass / n`
(output shape), `factualPass / n` (consistent with grounding context), and
`hallucinationFreePass / n` (no invented URLs/selectors/field names);
`overallPass / n` requires all three. `overallPass / n ≥ 0.9` (default
threshold) means nothing to heal.

**Step 3 — Self-heal (below threshold):**

```bash
pnpm run heal:llm -- \
  --verdict-path judge-out/verdict-<callType>-<batchIndex>.json \
  --call-type <callType> \
  [--max-iterations <N>] [--n-replays <N>] [--success-threshold <0..1>] \
  [--plateau-delta <0..1>] [--plateau-window <N>] [--out-dir llm-heal-out] \
  [--judge-model <model>] [--dry-run]
```

Defaults: 5 iterations, 5 replays per arm, success threshold 0.9. Cost warning:
`failures × n_replays × max_iterations` Anthropic calls — up to 250 for 10
failing samples at defaults. `--dry-run` stubs both scorer and patch generator, exits `BUDGET_EXHAUSTED`.

**Step 4 — Review** `llm-heal-out/<callType>/healing-<callType>.md` (verdict,
best `{anchor, replacement}` patch, iteration table) and `state.json`.
Verdicts: `SUCCESS`, `PLATEAUED` (no improvement above `plateauDelta` across
`plateauWindow` iterations), `BUDGET_EXHAUSTED`, `TIMEOUT`, `REGRESSED`.

**Step 5 — Apply by hand.** The loop never modifies source. Locate the call
site and substitute the anchor:

| `callType` | Source file |
|------------|------------|
| `recon-rephrase` / `recon-replan` | `src/scripts/recon-browser.ts` |
| `recon-flow-patch` | `src/scripts/recon-heal.ts` |
| `llm-prompt-patch` | `src/scripts/llm-heal.ts` |

Re-run the judge to confirm the patch raised the pass rate. Same
manual-apply discipline as 6D: a patch backed by measured evidence still
needs human review before `main`.

---

## What changes, how you find out, how fast you fix it

### Change severity

| Severity | What changed | Symptom |
|----------|-------------|---------|
| Low | Response field added or renamed | Zod schemas start failing; existing consumers may be unaffected |
| Medium | Query shape required by server changes | A requested field is rejected, or a new required argument appears — hot path 4xx |
| High | Endpoint path or host moves | `404` on every call |
| High | Bot detection tightens | `403` on plain `fetch()`; direct HTTP is dead |
| Severe | Auth requirements appear | What was public now requires a session token |

### The fix ladder

| Severity | Response | Time-to-fix |
|----------|----------|-------------|
| Schema drift | Update Zod schema; re-deploy. Fallback covers the gap. | < 1 hour |
| Query shape rejected | Re-run Phase 1 against the broken operation; diff and update. | < 4 hours |
| Endpoint moved | Re-run Phase 1 fully; re-do Phases 2–4. | 1 day |
| Bot detection tightened | Flip to fallback-only while investigating new headers. | Minutes to flip; days to restore |
| Auth appeared | Capture-and-refresh token, or accept Stagehand-only. | Days to weeks |

### What protects you before the change is visible

- **Zod at the boundary.** A response that stops matching fails loudly
  rather than returning garbage — the single most important defensive
  measure.
- **Stagehand fallback is always hot.** Site changes degrade cost and
  latency, not availability.
- **Recon-time self-healing.** The 5-attempt cascade (1c) plus up to two
  global replans (1e) mean a single recon run usually produces a working
  capture set even from a rough flow.
- **Runtime fallback retries the whole flow.** `plugin.execute()` is wrapped
  in `withScraperRetry` — 3 attempts, exponential backoff, classified by
  error type — verified by the plugin's Zod schema.
- **Committed artifacts make the diff trivial.** `git log` on the captured
  query shows exactly when the target's shape last changed.

---
For the design rationale behind this approach — alternatives compared and why
they lose — see [architecture.md](./architecture.md).
