# Barnacle Architecture — Design Theory & Rationale

> This document explains *why* Barnacle is built the way it is — the design
> decisions behind each layer, the alternatives considered, and the
> invariants you should preserve when extending it.
>
> For the mental model, the one-paragraph pitch, and the pipeline
> walkthrough, see [../README.md](../README.md). For *how* to run the
> pipeline step by step, see [playbook.md](./playbook.md). For *how* to
> write a site plugin, see the Plugin Authoring Guide in
> [../README.md](../README.md).

---

## Runtime design rationale

### Why hot path + browser fallback, not browser on every call

A Stagehand browser session (Browserbase by default, Steel as the opt-in
fallback via `SCRAPER_PROVIDER=steel`) costs real money and takes 5–15 seconds:
browser cold-start, navigation, LLM inference for selector resolution.
At any meaningful request volume, that's the wrong default path.

The recon pipeline proves that the target's API endpoints respond to plain
`fetch()` without a browser in the loop. Once proven, the hot path hits
those endpoints directly: milliseconds of latency, fractions of a cent per
call. The browser only re-engages when the direct path breaks — schema
mismatch, bot challenge, server error. That's rare.

Critically, the fallback is always deployed and always warm. Site changes
degrade cost and latency, not availability. Users don't notice the hot path
is down; ops does — via `fallbackActivations` rising on the dashboard.

### Why `dispatch()` is in core, not the plugin

Plugins describe *what* to do (the hot path implementation, the browser
flow, the schemas). Core (`src/plugins/loader.ts`) decides *when* to use
which path. This separation means:

- Plugins can't accidentally bypass the cache, skip metrics, or forget to
  emit the submission envelope.
- Adding a new site requires zero changes to core — one import + one push
  to `BUILTIN_SITE_PLUGINS`.
- The fallback logic is tested once, in one place.

The submission envelope follows the same rule: `dispatch()` merges a
plugin's optional `extractJoinKeys` hook output with whatever the plugin
attached to `context.telemetry` during `execute()`/`executeHttp()`, then
stamps the combined, still-opaque result onto the submit envelope and (when
the plugin declares no `extractJoinKeys`) the tracking-click beacon. Core
never inspects what's inside `joinKeys` on either side of that merge — a
plugin owns its shape entirely. See
[telemetry-and-judging.md § Submission envelope sink](./telemetry-and-judging.md#submission-envelope-sink)
for the full field reference and the reasoning behind each part of that
record's shape.

**Browser-execution escape hatch.** Sending `x-barnacle-execution: browser`
on a plugin request causes `dispatch()` to skip `executeHttp` and route
straight to the browser path (`src/plugins/loader.ts:364`). Used by the
nightly smoke test (`src/scripts/smoke-test.ts`) to exercise the browser
path even when the hot path is healthy, and available to on-call for
diagnosis when the hot path is suspect. Header name is lowercase — Fastify
normalizes incoming header keys.

### Why LRU cache + in-flight coalescing

The LRU cache prevents repeated identical requests from hitting the target
API at all. The in-flight coalescing layer (`getOrCreateInFlight`) prevents
a thundering-herd fan-out: if 10 identical requests arrive while the first
is still in-flight, all 10 await the same origin promise. Only one request
ever leaves the process per unique (endpoint, payload) pair per TTL window.

Cache key = `<endpoint>:<sha256(canonical payload)[:32]>`. Object key order
and primitive array order are normalized before hashing, so `{a:1,b:2}` and
`{b:2,a:1}` hit the same entry. Cache hits are excluded from `p95LatencyMs`
metrics — they're memory reads and must not bias the origin latency signal.

### Why `p-queue` with bounded concurrency

A raw `Promise.all` pool would let traffic spikes spin up arbitrarily many
browser sessions simultaneously. `p-queue` with `concurrency = SESSION_POOL_SIZE`
caps that. Sessions are created on demand inside each queued task — not
pre-warmed — so provider billing stays proportional to actual traffic, not
to pool capacity. `/readyz` exposes `pool.size + pool.pending` as a
backpressure signal.

### Why a per-task hang ceiling

A hung Stagehand operation would hold a `p-queue` concurrency slot
indefinitely, draining pool capacity without recovery. `runWithSession`
wraps every queued task in a hard timeout (`TASK_TIMEOUT_MS` in
`src/scraper/pool.ts`, **60 minutes** by default) that converts a silent
hang into a `SessionTimeoutError` the retry policy can act on. The default
is large because production browser flows routinely run for minutes — this
is a hang-recovery floor, not a p99 latency budget. Plugins may shorten it
via `SitePluginMeta.taskTimeoutMs`.

### Why viewport rotation

A fixed pixel size is a trivially cheap bot-detection fingerprint. Rotating
across four realistic desktop viewports (`1280×720`, `1366×768`, `1440×900`,
`1920×1080`) makes session fingerprints harder to cluster by browser
detection systems.

### Why per-plugin Bottleneck, not global rate limiting

Different target sites have different rate-limit ceilings. A global limiter
would cap all plugins to the most restrictive site's ceiling. Per-plugin
Bottleneck instances (created in the plugin's contract file) let each site
operate at its own discovered ceiling from the Phase 3 probe. The Fastify
global rate limit (`@fastify/rate-limit`) is orthogonal — it limits inbound
traffic to Barnacle's own API, not outbound traffic to target sites.

---

## Error classification rationale

`withScraperRetry` (`src/scraper/retry.ts`) applies a different policy to
each error class:

| Error | Policy | Reason |
|-------|--------|--------|
| `CaptchaError` | Abort immediately | The provider's built-in solver handles most CAPTCHAs when `SCRAPER_SOLVE_CAPTCHA=true`. This row is the residual case where the solver fails — it needs human intervention; burning more sessions just makes the IP look more like a bot. |
| `EmptyResultsError` | Abort immediately | Empty results are a query-shape bug, not a transient failure. Retrying the same malformed query will always return empty. |
| `SessionTimeoutError` | Kill session → create fresh → retry up to `maxAttempts` | The session itself is corrupted. `onSessionRestart` runs before every retry attempt, not just the first. |
| `SelectorFailureError` | Retry with backoff | Stagehand cache may have a stale selector. Retry forces LLM re-resolution — usually recovers in 1–2 retries. |
| `UnknownScraperError` | Retry with backoff | Catch-all for transient network/Playwright errors. Exponential backoff with jitter prevents retry storms. |

Concrete settings: `factor: 2`, `minTimeout: 500ms`, `maxTimeout: 5000ms`,
`randomize: true`, default `maxAttempts: 3` (lowerable per plugin via
`SitePluginMeta.maxAttempts`).

Hot-path → fallback decision (in `dispatch()`):

| Hot-path error | Triggers browser fallback? | Reason |
|---------------|--------------------------|--------|
| `HttpSchemaError` | Yes | Response shape drifted; browser may still return the right data via DOM extraction |
| `HttpBotChallengeError` | Yes | 401/403 from edge; residential proxy in the browser session may get through |
| `HttpServerError` | Yes | 5xx; recovery strategy is the same regardless of path |
| `HttpRateLimitError` | **No** | 429 means back off — burning a browser session against a rate-limited endpoint just costs money |

---

## Error codes

Client-facing error codes (`ERROR_CODES`, `src/api/schemas/common.ts`). HTTP
status is selected by `httpStatusForCode()` — never hard-code statuses:

| Code | Name | HTTP | Meaning |
|------|------|------|---------|
| 1010 | `THROTTLED_REQUEST` | 429 | Target site rate-limited; do not retry the hot path immediately. |
| 1011 | `TIME_OUT` | 504 | Task exceeded `TASK_TIMEOUT_MS`. |
| 2003 | `SCRAPE_FAILURE` | 500 | Scraper failure after retries exhausted. |
| 2004 | `CAPTCHA_ENCOUNTERED` | 500 | Anti-bot challenge the session could not solve. |
| 2005 | `EMPTY_RESULTS` | 404 | Structurally valid but empty response (treated as resource-not-found). |

Framework-level codes (`1001 DECODING_ERROR`, `1002 FIELD_VIOLATION`,
`1004 AUTHORIZATION_ERROR`, …) live alongside these in the same file.

---

## What protects you before the change is visible

**Zod at the boundary.** The moment a response stops matching your schema,
the request fails loudly rather than silently returning garbage downstream.
Schema drift is caught at the first request, not when a consumer complains.

**Stagehand fallback is always hot.** No fallback to build when the hot
path dies — it already exists and is always deployed.

**Recon-time and runtime healing are deliberately different.** *Recon-time*
(`src/scripts/recon-browser.ts`) runs a 4-attempt cascade per step, with up
to two global flow replans on exhaustion — cost model is "infrequent,
expensive, must-be-correct." See [Recon recovery model](#recon-recovery-model)
below and `docs/playbook.md` §Phase 1c–1e for the full walkthrough. *Runtime*
(`src/scraper/retry.ts` + `src/plugins/loader.ts`) wraps `plugin.execute()`
in `withScraperRetry` — 3 attempts, exponential backoff, classified by error
type, verified by Zod. Coarse-grained but correct: the right shape for a
cost model where a high fallback rate means "re-run recon," not "make the
fallback smarter."

**Committed artifacts make the diff trivial.** `git log` on a captured query
file tells you exactly when the target's shape last changed.

**Nightly smoke test fails fast.** It validates a real response against the
full Zod schema nightly — drift surfaces at 03:00, not when users start
calling the API.

---

## Recon recovery model

This is the architectural reference for how `recon-browser` recovers from a
bad step; `docs/playbook.md` §Phase 1c–1e is the operator runbook for the
same content. Cost model: recon runs a few times a week at most, trading LLM
tokens for correctness — the output is a small, committed artifact (Zod
schema + base headers + rate ceiling) that then serves millions of cheap
hot-path requests.

### Per-step self-healing cascade

```
flow step "X"
  ├── attempt 1: stagehand.act("X")
  ├── attempt 2: stagehand.observe("X") → act(topAction)
  ├── attempt 3: stagehand.observe("X", { ignoreSelectors: tried }) → act(topAction)
  ├── attempt 4: Anthropic SDK rephrase("X", ...) → stagehand.act(rephrased)
  └── all exhausted → dumpStepFailure() + throw StepVerificationError
```

Each attempt verifies via network-counter delta or URL change and uses a
strictly more expensive recovery technique than the last; the cascade exits
the moment any attempt is verified. DOM-state comparison was tried and
removed as a verifier — two `observe()` calls post-act always compared
false, burning tokens for no signal. Linear backoff `attempt * 1000ms`
between attempts.

Implementation: `executeStepWithHealing` in `src/scripts/recon-browser.ts`.
Constants: `MAX_STEP_ATTEMPTS = 4`, `ATTEMPT_BACKOFF_MS = 1000`. The
terminal error is `StepVerificationError` (`src/scraper/errors.ts`); at
runtime, `runHealingFlow` (`src/scraper/flow-runner.ts`) throws the same
class on a step-verification failure, and `withScraperRetry` aborts
immediately rather than retrying — a deterministic verification failure
won't resolve by re-running the whole flow.

### Global replan loop

When the cascade exhausts, `main()` catches the error and attempts up to
two global flow replans (`replanRemainingFlow`,
`src/scripts/recon-browser.ts`) before giving up. Claude receives the
original flow, the completed steps, the failed step, the remaining tail,
current page state, and the failure dump, and returns either a JSON array
of new steps or `IMPOSSIBLE`. Only the remaining tail is rewritten —
completed steps are held fixed and never re-executed. The on-disk
`--flow-file` is never modified — humans own the canonical source.

Constants: `MAX_REPLANS = 2`, `REPLAN_MAX_STEPS = 20`. Bedrock-only
deployments skip attempt-4 rephrase and the replan loop with a startup
warn; the first three cascade attempts still run.

### Artifacts on disk

- `<run-dir>/graphql/<NNN>-<phase>-<op>.json` — every captured network call.
- `<run-dir>/step-failures/<NNN>-<phase>.json` — diagnostic dump on cascade
  exhaustion.
- `<run-dir>/step-failures/<NNN>-<phase>.replan.json` — audit record when a
  replan succeeds.

`<run-dir>` defaults to `/tmp/recon/<runId>`, resolved by
`resolveReconRunDir()` (`src/scripts/recon-shared.ts`) — override with
`RECON_OUT_DIR` or `RECON_RUN_ID`.

---

## Telemetry, judging, and self-healing rationale

### Why structured NDJSON, not log lines

Every LLM call Barnacle makes at recon-time is written as a validated
NDJSON record to `.barnacle/calls.ndjson` via `captureLlmCall`
(`src/lib/telemetry/call-capture.ts`) — full field reference in
[telemetry-and-judging.md](./telemetry-and-judging.md). NDJSON wins over
Pino log lines for two reasons: the judge and self-heal skills need a
*scoreable, replayable* corpus (a log line can't be fed back into a scorer
as a typed sample), and NDJSON is append-only and crash-safe — a run that
aborts mid-recon leaves a partial file where every line is still parseable.
Capture is fire-and-forget: errors are logged and swallowed so telemetry
never breaks a submission.

### Why the reconciliation record has an opaque join-key bag

`.barnacle/submissions.ndjson` captures the durable per-run reconciliation
record — what was submitted, whether it succeeded, and whether the
conversion beacon fired. Full field reference and write paths:
[telemetry-and-judging.md § Submission envelope sink](./telemetry-and-judging.md#submission-envelope-sink).

The key design choice: `joinKeys` is an opaque `Record<string, unknown>`
bag, not named fields. An earlier version hardcoded two attribution
vendors' field names (`vivclid`, `jobReference`) directly onto the schema —
a site-agnostic-boundary violation, since core has no more business knowing
an attribution vendor's vocabulary than it does the rest of a plugin's
payload (see [§Why `dispatch()` is in core](#why-dispatch-is-in-core-not-the-plugin)
above). The fix: a plugin declares an optional `extractJoinKeys(payload)`
hook; `dispatch()` calls it once against the inbound payload, merges the
result with anything the plugin attached mid-run via
`context.telemetry.addJoinKeys()` (`RunTelemetry`,
`src/lib/telemetry/run-telemetry.ts` — last write wins), and stamps the
combined bag onto the envelope without inspecting either half. Query routes
(`GET /v1/submissions`) filter only on fields every plugin needs regardless
of vendor (`siteId`, `requestId`, `status`, `beaconStatus`, a time window);
`joinKeys`-specific filtering is left to the plugin's own tooling.

Beacon-fire is tracked as a separate dimension from submit `status`, not a
mutation of the submit record, because rewriting an already-flushed NDJSON
line would break the append-only write model. A self-managing plugin (one
with `extractJoinKeys`) reports its own outcome via
`context.recordBeaconOutcome`; `foldReconciliationRecords`
(`src/lib/telemetry/submission-reader.ts`) ranks a real `"fired"`/`"failed"`
outcome above core's synchronous `"skipped"` placeholder line, so a real
outcome always wins the fold regardless of write order.

### Why judging is offline over captured samples

The judge (`pnpm run judge:llm`, `src/scripts/judge-llm-batch.ts`) scores
captured samples on schema adherence, factual grounding, and
hallucination-freeness, entirely offline after a recon run — not inline as
each call completes. Inline judging would double the token cost and latency
of the already-expensive recon pipeline for observability only, not
correctness. Offline scoring over a batch buys the same signal at a
fraction of the cost, and gives a stable baseline: the same capture file can
be re-judged with a different model or patched prompt for a direct
pass-rate comparison.

### Why self-heal proposes patches for human review rather than auto-editing source

The self-heal loop (`pnpm run heal:llm`, `src/scripts/llm-heal.ts`) runs a
measured-baseline → patch-proposal → replay → convergence cycle for failing
LLM call templates and writes a `healing-<callType>.md` report. It **never**
modifies `src/` — the same "tool produces evidence, human applies judgment"
invariant as the recon-flow cascade (`docs/playbook.md` §Phase 1e). Two
reasons this matters for prompt templates specifically: a patch that
improves the pass rate on the captured corpus may still degrade on live
inputs outside it, and prompt changes are semantically load-bearing text
invisible to static analysis — human review is the last verifier.

The recon-flow cascade (`src/scripts/recon-heal.ts`) and this loop share the
same anchor/replacement patch discipline and convergence checker, but target
different artifacts: the recon-flow cascade heals `recon-flow.json` step
strings (committed JSON humans own); this loop heals prompt templates
embedded in TypeScript source (a higher bar for auto-modification). Both
leave the source of truth unchanged until a human reviews and applies the
patch.

---

## Why this approach wins — the alternatives

| Approach | Cost/req | Latency | Fragile to UI | Fragile to API | Handles auth | Effort |
|----------|----------|---------|---------------|----------------|--------------|--------|
| Browser on every call | High | High | Medium | Low | Yes | Low |
| HTML screen scraper | Low | Low | **High** | Low | Yes | Medium |
| Manual DevTools recon | Low | Low | Low | High (human redo) | Yes | **High (ongoing)** |
| Official partner API | — | — | — | — | Depends | Often unavailable |
| HAR replay | Low | Low | Medium | **High** | Limited | Medium |
| Direct HTTP from scratch | Low | Low | Low | **High** | Hard | Impossible-to-high |
| **Recon → codify → direct HTTP + fallback (Barnacle)** | **Low** | **Low** | **Low** | Low (re-runnable) | Yes (via fallback) | Medium, front-loaded |

Front-loaded recon work buys an integration as cheap as direct HTTP from
scratch, as robust as browser on every call, and maintainable in a way none
of the hand-rolled options are.

- **Browser on every request** — what Barnacle uses as fallback only, after
  direct HTTP has been proven sufficient. Orders of magnitude more
  expensive at scale, and 5–15s/request is not viable for interactive
  traffic.
- **Hand-written HTML scraper** — scrapes the wrong layer. CSS selectors
  break on every UI redesign, far more often than the API changes, and HTML
  only contains what the UI renders.
- **Reverse-engineer by hand (DevTools)** — exactly what Barnacle does, but
  automated: `recon:browser` reruns unattended (~20–40 min) and produces
  diffable captures instead of costing hours of human re-work per change.
- **Ask the partner for an official API** — always try this first. Many
  partners have no public program, or charge six figures for access, while
  their SPA already calls a usable internal API over the open internet.
- **HAR replay** — a static snapshot of one session; misses the AI
  navigation needed for conditional flows, and ships the whole recording to
  production instead of a trimmed, committed query.
- **Direct HTTP from day one, no browser** — right runtime destination,
  wrong starting point. Without the browser as oracle you'd have to guess
  query shape, headers, rate limits, and filter encoding blind.

---

## File map

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
