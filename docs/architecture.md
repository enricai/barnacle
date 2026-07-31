# Barnacle Architecture — Design Theory & Rationale

> This document explains *why* Barnacle is built the way it is — the mental
> model, the design decisions behind each layer, the alternatives considered,
> and the invariants you should preserve when extending it.
>
> For *how* to run the pipeline step by step, see [playbook.md](./playbook.md).
> For *how* to write a site plugin, see the Plugin Authoring Guide in
> [../README.md](../README.md).

---

## Mental model

> *Stagehand is the teacher. The runtime is a student who only needs to open
> the textbook. Every phase runs from a script — human involvement is writing
> the flow definition once, then reviewing a PR when the site changes.*

Modern SPAs are thick clients. The page is just a shell — all the data you
care about flows through the network layer as GraphQL or JSON API calls. The
browser already knows how to make those calls correctly. Barnacle uses an
AI-driven browser to *learn* the exact bytes the site sends, then discards
the browser in production and sends those same bytes directly.

**The browser is the oracle.** After Phase 1, you don't need it anymore —
until the site changes.

This framing has one important corollary: the recon pipeline is not a
one-time setup step. It's the maintenance loop. Every time the site changes,
recon reruns unattended (~20–40 min for a typical flow) and produces a fresh
diff. The committed captures are the source of truth; `git log` on a capture
file tells you exactly when the target's shape last changed.

---

## Pipeline at a glance

| Phase | Script / action | Automation |
|-------|-----------------|------------|
| 0 — Define flow | `src/sites/<id>/recon-flow.json` | Human (once) |
| 1 — Browser recon | `pnpm run recon:browser` | Fully automated |
| 2 — HTTP replay | `pnpm run recon:http` | Fully automated |
| 3 — Edge probing | (same script) | Fully automated |
| 4 — Codify contract | `src/sites/<id>/contract.ts` | One human PR |
| 5 — Runtime | `dispatch()` in `src/plugins/loader.ts` | Fully automated |
| 6 — Drift detection | Nightly smoke test + `/readyz` metrics | Fully automated |

Human work is front-loaded to Phase 0 (writing the flow once) and Phase 4
(one PR). Everything else runs from scripts. See [playbook.md](./playbook.md)
for the step-by-step.

---

## Runtime design rationale

### Why hot path + browser fallback, not browser on every call

A Stagehand + Steel session costs real money and takes 5–15 seconds:
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
  to `SITE_PLUGINS`.
- The fallback logic is tested once, in one place.

**Browser-execution escape hatch.** Sending `x-barnacle-execution: browser`
on a plugin request causes `dispatch()` to skip `executeHttp` and route
straight to the browser path (`src/plugins/loader.ts:341`). Used by the
nightly smoke test (`src/scripts/smoke-test.ts`) to exercise the browser
path even when the hot path is healthy, and available to on-call for
diagnosis when the hot path is suspect. Header name is lowercase — Fastify
normalizes incoming header keys.

### Why LRU cache + in-flight coalescing

The LRU cache prevents repeated identical requests from hitting the target
API at all. The in-flight coalescing layer (`getOrCreateInFlight`) prevents
a thundering-herd fan-out: if 10 identical requests arrive while the first
is still in-flight, all 10 await the same upstream promise. Only one request
ever leaves the process per unique (endpoint, payload) pair per TTL window.

Cache key = `<endpoint>:<sha256(canonical payload)[:32]>`. Object key order
and primitive array order are normalized before hashing, so `{a:1,b:2}` and
`{b:2,a:1}` hit the same entry.

Cache hits are excluded from `p95LatencyMs` metrics — they're memory reads
and must not bias the upstream latency signal.

### Why `p-queue` with bounded concurrency

A raw `Promise.all` pool would let traffic spikes spin up arbitrarily many
Steel sessions simultaneously. `p-queue` with `concurrency = SESSION_POOL_SIZE`
caps that. Sessions are created on demand inside each queued task — not
pre-warmed — so Steel billing stays proportional to actual traffic, not to
pool capacity.

The queue also provides a natural backpressure point. `/readyz` exposes
`pool.size + pool.pending` so ops can alert when the queue depth exceeds
a threshold, before users start experiencing latency.

### Why a per-task hang ceiling

A hung Stagehand operation — frozen CDP connection, infinite network wait,
a `page.goto` that never resolves — would hold a `p-queue` concurrency slot
indefinitely, draining pool capacity without recovery. `runWithSession`
wraps every queued task in a hard timeout (`TASK_TIMEOUT_MS` in
`src/scraper/pool.ts`, **60 minutes** by default). The ceiling converts a
silent hang into a `SessionTimeoutError` that the retry policy can act on
by tearing down the broken session and creating a fresh one.

The default is intentionally large because production browser flows
(multi-step recon, slow government portals) routinely run for minutes. The
timeout is a hang-recovery floor, not a p99 latency budget. Individual
plugins may shorten it via `SitePluginMeta.taskTimeoutMs`; none of the
shipped plugins do.

### Why viewport rotation

A fixed pixel size (e.g., always 1280×720) is a trivially cheap bot-detection
fingerprint. Rotating across four realistic desktop viewports
(`1280×720`, `1366×768`, `1440×900`, `1920×1080`) makes session fingerprints
harder to cluster by browser detection systems.

### Why per-plugin Bottleneck, not global rate limiting

Different target sites have different rate-limit ceilings. A global limiter
would cap all plugins to the most restrictive site's ceiling. Per-plugin
Bottleneck instances (created in the plugin's contract file, passed to
`createHttpClient`) let each site operate at its own discovered ceiling from
the Phase 3 probe.

The Fastify global rate limit (`@fastify/rate-limit`) operates on a separate
axis — it limits inbound traffic to Barnacle's own API, not outbound traffic
to target sites. Both limiters are active simultaneously; they're orthogonal.

---

## Error classification rationale

`withScraperRetry` (`src/scraper/retry.ts`) applies a different policy to
each error class. Here's why each decision was made:

| Error | Policy | Reason |
|-------|--------|--------|
| `CaptchaError` | Abort immediately | Steel's built-in solver handles most CAPTCHAs transparently when `SCRAPER_SOLVE_CAPTCHA=true` (default). This row covers the residual case where the solver fails: at that point the CAPTCHA needs human intervention, and burning more sessions just makes the IP look more like a bot. Surface immediately. |
| `EmptyResultsError` | Abort immediately | Empty results are a query-shape bug, not a transient failure. Retrying the same malformed query will always return empty. Fix the query. |
| `SessionTimeoutError` | Kill session → create fresh → retry up to `maxAttempts` | The session itself is corrupted (hung CDP, stale context). `onSessionRestart` is invoked before every retry attempt, not just the first, so a stuck session is never left running between repeat timeouts. |
| `SelectorFailureError` | Retry up to `maxAttempts` with backoff | Stagehand cache may have a stale selector. Retry forces LLM re-resolution. Usually recovers in 1–2 retries. |
| `UnknownScraperError` | Retry up to `maxAttempts` | Catch-all for transient network or Playwright errors. Exponential backoff with jitter prevents retry storms. |

Concrete settings (`src/scraper/retry.ts`): `factor: 2`, `minTimeout: 500ms`,
`maxTimeout: 5000ms`, `randomize: true`, default `maxAttempts: 3` (a plugin
can lower this via `SitePluginMeta.maxAttempts` so `taskTimeoutMs` is a real
per-run cap instead of `maxAttempts × taskTimeoutMs`).
`EmptyResultsError`, `CaptchaError`, and `StepVerificationError` short-circuit
retries; `SessionTimeoutError` triggers a session restart before every retry
attempt, not just the first.

Hot-path → fallback decision (in `dispatch()`):

| Hot-path error | Triggers browser fallback? | Reason |
|---------------|--------------------------|--------|
| `HttpSchemaError` | Yes | Response shape drifted; browser may still return the right data via DOM extraction |
| `HttpBotChallengeError` | Yes | 401/403 from edge; residential proxy in the browser session may get through |
| `HttpServerError` | Yes | 5xx; recovery strategy is the same regardless of path |
| `HttpRateLimitError` | **No** | 429 means back off — burning a Steel session against a rate-limited endpoint just costs money and burns the session |

---

## Response envelope and error codes

Every response (success or failure) wraps its payload in a standard envelope:

```json
{
  "status": {
    "httpStatus": "OK",
    "dateTime": "2026-05-20T14:00:00.000Z",
    "details": []
  },
  "...": "site-specific payload fields"
}
```

On error, `details[]` carries one or more entries with a numeric `code` from
`ERROR_CODES` (`src/api/schemas/common.ts`). The HTTP status code is selected
by `httpStatusForCode()` (`src/api/errors.ts`) — never hard-code statuses.

Client-facing error codes:

| Code | Name | HTTP | Meaning |
|------|------|------|---------|
| 1010 | `THROTTLED_REQUEST` | 429 | Upstream rate-limited; do not retry the hot path immediately. |
| 1011 | `TIME_OUT` | 504 | Task exceeded `TASK_TIMEOUT_MS`. |
| 2003 | `SCRAPE_FAILURE` | 500 | Scraper failure after retries exhausted. |
| 2004 | `CAPTCHA_ENCOUNTERED` | 500 | Anti-bot challenge the session could not solve. |
| 2005 | `EMPTY_RESULTS` | 404 | Structurally valid but empty response (treated as resource-not-found). |

Framework-level codes (`1001 DECODING_ERROR`, `1002 FIELD_VIOLATION`,
`1004 AUTHORIZATION_ERROR`, …) live in `src/api/schemas/common.ts` and follow
the same envelope path.

---

## What protects you before the change is visible

**Zod at the boundary.** The moment a response stops matching your schema,
the request fails loudly rather than silently returning garbage data
downstream. This is the single most important defensive measure. Schema drift
is caught at the first request, not when a downstream consumer complains.

**Stagehand fallback is always hot.** You don't have to build a fallback when
the hot path dies — it already exists and is always deployed. Site changes
degrade cost and latency, not availability.

**Recon-time and runtime healing are deliberately different.** It's tempting
to lump these together; they solve different problems.

*Recon-time* (in `src/scripts/recon-browser.ts`): each flow step runs through
a 4-attempt cascade — `act(string)` → `observe + act(Action)` → `observe + act`
with `ignoreSelectors` → Anthropic-SDK rephrase — verified by network-counter
delta or URL change. On cascade exhaustion the script also attempts up to two
global flow replans where Claude rewrites the remaining tail given the failure
context. The cost model is "infrequent, expensive, must-be-correct" — recon
runs a few times a week at most, and the output is a small committed artifact.
We explicitly set `selfHeal: false` on Stagehand because its built-in heal only
catches Playwright throws, not the silent semantic misses we actually need to
recover from. See `docs/playbook.md` sections 1c–1e for the full design.

*Runtime* (in `src/scraper/retry.ts` + `src/plugins/loader.ts`): when the hot
HTTP path throws a schema-mismatch / bot-challenge / 5xx, dispatch falls back
to the browser and wraps the entire `plugin.execute()` in `withScraperRetry`
— 3 attempts, exponential backoff 500ms→5s, classified by error type. The
verifier here is Zod: if extraction returns garbage, parse fails, the flow
restarts with a fresh selector cache. Coarse-grained but correct, and the
right shape for the runtime cost model where the answer to a high fallback
rate is to re-run recon, not to make the fallback smarter.

**Committed artifacts make the diff trivial.** `git log` on the captured
query file tells you exactly when the target's shape last changed. You're
never guessing what changed or when — you have a diffable capture archive.

**Nightly smoke test fails fast.** The smoke test validates a real response
against the full Zod schema nightly. Schema drift surfaces at 03:00, not at
10:00 when users start calling the API.

---

## Recon recovery model

This section is the architectural reference for how recon-browser recovers
from bad steps. The playbook (`docs/playbook.md` Phase 1c–1e) is the operator
runbook for the same content; consult that for usage. The cost model: recon
runs a few times a week at most when a site changes, and we explicitly trade
LLM tokens for correctness — the output is a small, committed artifact
(Zod schema + base headers + rate ceiling) that then serves millions of cheap
hot-path requests.

### Per-step self-healing cascade

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

Each attempt uses a strictly more expensive recovery technique than the last,
and we exit the moment any attempt is verified. The verifier is network
counter delta OR URL change — DOM-state comparison was tried and removed
(two `observe()` calls post-act produced a comparison that was always false,
so it burned LLM tokens for no signal). Linear backoff `attempt * 1000ms`
between attempts.

Attempt 3's `ignoreSelectors` list only has entries when earlier attempts
captured selectors via `ActResult.actions` or `observe()` candidates. If both
returned nothing actionable, attempt 3 degenerates to a plain `observe(step)`
identical to attempt 2 — a rare edge case worth knowing when reading logs.

Implementation: `executeStepWithHealing` in `src/scripts/recon-browser.ts`.
Constants: `MAX_STEP_ATTEMPTS = 4`, `ATTEMPT_BACKOFF_MS = 1000`. The terminal
failure error is `StepVerificationError` (`src/scraper/errors.ts`). It
originates in recon's per-step cascade, but `runHealingFlow`
(`src/scraper/flow-runner.ts`) throws the same error class at runtime on a
step-verification failure; `withScraperRetry` catches it there and aborts
immediately rather than retrying — a deterministic verification failure
won't resolve by re-running the whole flow.

### Global replan loop

When the cascade exhausts, the script's `main()` loop catches the error and
attempts up to two global flow replans before giving up:

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

The replan rewrites only the *remaining tail* — already-completed steps are
held fixed and never re-executed. Claude is given the original flow as the
user wrote it, the steps that already succeeded, the failed step, the
remaining tail, current page URL/title, the first ~12 `observe()` candidates,
and the path to the step failure dump. It returns either a JSON array
(validated by `z.array(z.string().min(1)).min(1).max(REPLAN_MAX_STEPS)`) or
the literal string `IMPOSSIBLE`. The `--flow-file` on disk is never modified —
humans own the canonical source.

Implementation: `replanRemainingFlow` and `dumpReplanRecord` in
`src/scripts/recon-browser.ts`. Constants: `MAX_REPLANS = 2`,
`REPLAN_MAX_STEPS = 20`. Bedrock-only deployments skip both attempt-4 rephrase
and the replan loop with one startup warn — the first three cascade attempts
still run and cover the majority of recovery.

### Artifacts on disk

- `<run-dir>/graphql/<NNN>-<phase>-<op>.json` — every captured network call.
- `<run-dir>/step-failures/<NNN>-<phase>.json` — diagnostic dump on cascade
  exhaustion: full `attempts[]`, `finalObserve`, `pageUrl`, `pageTitle`,
  `recentCaptures`.
- `<run-dir>/step-failures/<NNN>-<phase>.replan.json` — audit record when a
  replan succeeds: `timestamp`, `stepIndex`, `phase`, `replanIndex`,
  `completedSteps`, `originalRemaining`, `newRemaining`.

`<run-dir>` defaults to `/tmp/recon/<runId>` and is resolved once per process
by `resolveReconRunDir()` in `src/scripts/recon-shared.ts` — override the base
with `RECON_OUT_DIR` or pin the runId with `RECON_RUN_ID`.

---

## Telemetry, judging, and self-healing rationale

### Why structured NDJSON, not log lines

Every LLM call Barnacle makes at recon-time (attempt-4 rephrase, global replan,
recon-flow-patch proposals, llm-prompt-patch proposals) is written as a validated
NDJSON record to `.barnacle/calls.ndjson` via `captureLlmCall`
(`src/lib/telemetry/call-capture.ts`). Each line carries the full call context:
`callType`, `model`, `systemPrompt`, `userContent`, `responseContent`,
`parsedOk`, token counts, latency, and a timestamp.

Structured NDJSON is the right format here for two concrete reasons. First, the
judge and self-heal skills need a *scoreable corpus* — they filter by `callType`,
replay individual samples, and compare pass rates across iterations. Pino's
unstructured log lines are searchable but not replayable; you can't feed a log
line back into a scorer as a typed `LlmCallSample`. Second, NDJSON is
append-only and crash-safe: a run that aborts mid-recon leaves a partial capture
file that is still fully valid — every line is independently parseable.

Telemetry capture is fire-and-forget — errors are logged and swallowed so a disk
full or permission error never breaks the recon run. The capture is a diagnostic
instrument, not a load-bearing path.

### Why judging is offline over captured samples

The judge (`pnpm run judge:llm`, `src/scripts/judge-llm-batch.ts`) reads the capture
file, filters by `callType`, and scores each sample on three dimensions: schema
adherence (`parsedOk` + structure check), factual grounding, and
hallucination-freeness. It runs entirely offline — after a recon run or a
batch of replays — not inline as each LLM call completes.

This is deliberate. Inline judging would add a second LLM call to every
production path (the rephrase or replan call *plus* the judge call), doubling
the token cost and latency on the already-expensive recon pipeline. The cost
model for recon is "infrequent, expensive, must-be-correct" (see §Recon recovery
model above) — we trade tokens for correctness, but inline scoring would buy
only observability, not correctness, and at full price on every run. Offline
scoring over a batch of captures buys the same observability signal at a fraction
of the cost, without touching the hot or recon paths at all.

Offline scoring also provides a stable baseline: you can re-judge the same
capture file with a different judge model or a patched prompt and compare the
pass rates directly, because the inputs are frozen. Inline judging has no
equivalent — each call is transient and unrepeatable.

### Why self-heal proposes patches for human review rather than auto-editing source

The self-heal loop (`pnpm run heal:llm`, `src/scripts/llm-heal.ts`) runs a
measured-baseline → patch-proposal → replay → convergence cycle for failing LLM
call templates. When the loop converges, it writes a `healing-<callType>.md`
report containing the best patch and the pass-rate trajectory. It **never**
modifies any source file in `src/`.

This mirrors the same invariant already established for the recon-flow
self-healing cascade (see `docs/playbook.md` §Phase 1e and §Recon recovery model
above): *the tool produces evidence; the human applies judgment.* There are two
concrete reasons this invariant matters for LLM prompt templates specifically.

First, a patch that improves the pass rate in the heal environment — which
replays a captured sample corpus — may still degrade behavior on live inputs not
in the corpus. The pass rate on captured samples is a proxy for correctness, not
a proof. A human reviewer can compare the patched and original prompts, check
the worst-offender excerpts in the report, and decide whether the improvement
generalises.

Second, prompt templates are semantically load-bearing text. An anchor/replacement
edit that looks locally safe can silently shift the instruction boundary for
other parts of the same prompt. Unlike a function signature change (where the
type-checker catches incompatibilities), prompt changes are invisible to static
analysis. Human review is the last verifier.

The loop's convergence signals (`SUCCESS`, `PLATEAUED`, `BUDGET_EXHAUSTED`,
`REGRESSED`, `TIMEOUT`) surface in the `/readyz` endpoint's `heal` field and in
the report, so operators can track whether a failing call type is trending
toward resolution without needing to inspect the iteration artifacts directly.

### How this differs from the recon-flow cascade

The recon-flow healing cascade (`src/scripts/recon-heal.ts`) and the LLM
prompt-template self-heal (`src/scripts/llm-heal.ts`) share the same
anchor/replacement patch discipline and the same convergence checker
(`checkConvergence` in `recon-heal.ts`), but they operate on different artifacts
and at different cost points.

The recon-flow cascade heals `recon-flow.json` flow-step strings — the
natural-language instructions a human wrote once for Phase 0. Its patch
generator (`recon-flow-patch-generator`) proposes rewording of those strings so
the step-execution cascade succeeds. The target artifact is committed JSON that
humans own.

The LLM prompt-template self-heal heals system/user prompt templates embedded in
TypeScript source code. Its patch generator (`llm-call-patch-generator`) proposes
edits to those prompt strings. The target artifact is source code — the bar for
auto-modification is higher than for a JSON config file.

Both loops share the same human-review discipline: a patch is evidence of
improvement in the captured-sample regime, not a commit. Both leave the source of
truth unchanged until a human reviews and manually applies the change.

---

## Why this approach wins — the alternatives

### The summary comparison

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

### Alternative A — Stagehand / browser on every request

This is what Barnacle uses as *fallback only*, after direct HTTP has been
proven sufficient.

- **Cost:** Steel minutes + Anthropic tokens on every production call. Orders
  of magnitude more expensive at scale.
- **Latency:** 5–15 seconds per request (browser cold-start + navigation +
  LLM inference). Not viable for interactive traffic.
- **Fragility:** More moving parts (browser, proxy, AI) = more failure modes.

**Verdict:** What we use as fallback only, after direct HTTP has been proven
sufficient.

### Alternative B — Hand-written HTML scraper (CSS selectors)

- **Fragility:** CSS selectors break on every UI redesign — which happens far
  more often than the API changes.
- **Information loss:** HTML only contains what the UI renders. The API
  response usually carries richer, better-structured data.

**Verdict:** Scraping HTML is scraping the wrong layer. We scrape the API the
SPA itself calls.

### Alternative C — Reverse-engineer by hand (manual DevTools)

This is exactly what we do — but automated. Phase 1 is a committed,
re-runnable script that replaces "open DevTools, click around, copy the
GraphQL call."

- Human DevTools re-runs cost hours when the site changes.
- `recon:browser` reruns unattended (~20–40 min for a typical flow).
- Auto-captured results are diffable against prior runs; human memory is not.

**Verdict:** Same approach — scripted, committed, and repeatable.

### Alternative D — Ask the partner for an official API

Always try this first. If they'll give you one, take it.

Many partners have no public API program, or charge six figures for access.
Meanwhile, their SPA calls a usable internal API over the open internet.

**Verdict:** This strategy is for when the partner can't or won't provide an
API, but the data is already publicly exposed.

### Alternative E — HAR replay (mitmproxy, tape)

- **Misses the AI piece.** A HAR is a static snapshot of one session. If your
  flow requires conditional clicks, you need AI navigation, not a replay tool.
- **Misses codification.** HAR replay ships the whole recording to production.
  Barnacle ships only the trimmed, committed query.

**Verdict:** Close, but a static technique for a dynamic problem.

### Alternative F — Direct HTTP from day one, no browser

Right runtime destination, wrong starting point.

- **The "you got lucky" problem.** You'd have to guess query shape, headers,
  rate limits, and filter encoding without ever seeing a real request. Dead
  end for anything non-trivial.
- **The browser is the oracle.** Phase 1 uses the browser to *learn* what
  to send. After that, yes — direct HTTP. Just day two of the pipeline.

**Verdict:** Right runtime destination, wrong starting point.

---

## Elevator pitch

We don't hand-write integrations against partner websites. We point an
AI-driven browser — Stagehand on a Steel cloud browser — at the site and
have it click through a normal user flow while a response listener wiretaps
every network call to disk. Then a separate script replays those captured
requests from plain Node `fetch()` — no browser, no AI — to prove the
endpoints work standalone. Once that passes, a generator script turns those captures into a plugin skeleton —
Zod schemas, load-bearing headers, and the query constant — which the developer reviews,
trims, and ships as a PR. The runtime hot path then hits the real API
directly: fast, cheap, deterministic. The AI browser only re-engages as a
fallback if that path breaks. A nightly smoke test tells us the moment a
contract drifts, and the whole recon script is re-runnable — that's our
maintenance loop.

**Four verifications:**
- `pnpm run smoke` — exercises the direct-HTTP hot path end-to-end
- Open `<run-dir>/graphql/*.json` after a recon run — these are real captures
- Diff `src/sites/<id>/contract.ts` against `<run-dir>/graphql/*<operationName>*.json` — the committed query should be a lean subset of the captured one (UI-only fields stripped)
- `docs/target-recon.md` is the human rollup from Phase 4e

---

## File map

| Concern | File |
|---------|------|
| Plugin contract interface | `src/site-plugin.ts` |
| Dispatch (hot path → fallback) | `src/plugins/loader.ts` |
| Fastify bootstrap + shutdown | `src/server.ts` |
| Frozen config singleton | `src/config.ts` |
| Bearer auth plugin | `src/api/plugins/auth.ts` |
| Global error serializer | `src/api/plugins/error-handler.ts` |
| Request/correlation ID propagation | `src/api/plugins/request-context.ts` |
| Error hierarchy + envelope builders | `src/api/errors.ts` |
| Success envelope builder | `src/api/helpers/envelope.ts` |
| Error codes + status schema | `src/api/schemas/common.ts` |
| Health routes (`/healthz`, `/readyz`) | `src/api/routes/health.ts` |
| Session bootstrap | `src/scraper/session.ts` |
| Session pool + timeout | `src/scraper/pool.ts` |
| Retry policy | `src/scraper/retry.ts` |
| Hot-path HTTP client | `src/scraper/http-client.ts` |
| Raw-fetch scaffold (undici + onResponse hook + optional status classify via `skipClassify`) | `src/scraper/raw-fetch.ts` |
| JSON-parse + Zod-validate seam for rawFetch callers | `src/scraper/parse-json-response.ts` |
| GraphQL client | `src/scraper/graphql-client.ts` |
| Per-plugin rate limiting | `src/scraper/throttle.ts` |
| Scraper error hierarchy (includes recon-only `StepVerificationError`) | `src/scraper/errors.ts` |
| Drift-detection metrics | `src/scraper/metrics.ts` |
| Static fixture loader | `src/scraper/fixtures.ts` |
| Response cache + coalescing | `src/cache/response-cache.ts` |
| Pino logger + CloudWatch splitting | `src/lib/logging.ts` |
| Environment variable parsers | `src/lib/env.ts` |
| AWS Bedrock model factory | `src/lib/bedrock.ts` |
| Phase 1 — browser recon | `src/scripts/recon-browser.ts` |
| Phase 2–3 — HTTP replay + probes | `src/scripts/recon-http.ts` |
| Phase 4f — plugin skeleton generator | `src/scripts/recon-generate.ts` |
| Phase 4e — findings doc generator | `src/scripts/recon-summarize.ts` |
| Shared recon types + utilities (`resolveReconRunDir`, `resolveLatestReconRunRoot`) | `src/scripts/recon-shared.ts` |
| Recon flow self-heal loop | `src/scripts/recon-heal.ts` |
| Smoke test | `src/scripts/smoke-test.ts` |
| Plugin contract interface (template for all site plugins) | `src/site-plugin.ts` |
| Findings doc (generated) | `docs/target-recon.md` |
| LLM call telemetry sink (NDJSON capture) | `src/lib/telemetry/call-capture.ts` |
| Canonical call_type constants | `src/lib/telemetry/call-types.ts` |
| Per-run telemetry state | `src/lib/telemetry/run-state.ts` |
| LlmCallSample + JudgeVerdict schemas | `src/api/schemas/telemetry.ts` |
| LLM batch judge | `src/scripts/judge-llm-batch.ts` |
| LLM prompt self-heal loop | `src/scripts/llm-heal.ts` |
