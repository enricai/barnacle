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
  write audit rows.
- Adding a new site requires zero changes to core — one import + one push
  to `SITE_PLUGINS`.
- The fallback logic is tested once, in one place.

**Force-fallback escape hatch.** Sending `x-barnacle-force-fallback: true`
on a plugin request causes `dispatch()` to skip `executeHttp` and route
straight to the browser path (`src/plugins/loader.ts:198`). Used by the
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
| `SessionTimeoutError` | Kill session → create fresh → retry up to `maxAttempts` | The session itself is corrupted (hung CDP, stale context). `onSessionRestart` is invoked at most once (a `done` flag prevents double-restart), then p-retry continues the normal attempt budget. |
| `SelectorFailureError` | Retry up to `maxAttempts` with backoff | Stagehand cache may have a stale selector. Retry forces LLM re-resolution. Usually recovers in 1–2 retries. |
| `UnknownScraperError` | Retry up to `maxAttempts` | Catch-all for transient network or Playwright errors. Exponential backoff with jitter prevents retry storms. |

Concrete settings (`src/scraper/retry.ts`): `factor: 2`, `minTimeout: 500ms`,
`maxTimeout: 5000ms`, `randomize: true`, default `maxAttempts: 3`.
`EmptyResultsError` and abort signals short-circuit retries;
`SessionTimeoutError` triggers a one-time session restart between attempts.

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
failure error is `StepVerificationError` (`src/scraper/errors.ts`) — recon-only,
non-retryable; the runtime path never sees it.

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

- `/tmp/recon/graphql/<NNN>-<phase>-<op>.json` — every captured network call.
- `/tmp/recon/step-failures/<NNN>-<phase>.json` — diagnostic dump on cascade
  exhaustion: full `attempts[]`, `finalObserve`, `pageUrl`, `pageTitle`,
  `recentCaptures`.
- `/tmp/recon/step-failures/<NNN>-<phase>.replan.json` — audit record when a
  replan succeeds: `timestamp`, `stepIndex`, `phase`, `replanIndex`,
  `completedSteps`, `originalRemaining`, `newRemaining`.

Paths are defined as `CAPTURES_DIR` and `STEP_FAILURES_DIR` in
`src/scripts/recon-shared.ts`.

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
- Open `/tmp/recon/graphql/*.json` after a recon run — these are real captures
- Diff `src/sites/<id>/contract.ts` against `/tmp/recon/graphql/*<operationName>*.json` — the committed query should be a lean subset of the captured one (UI-only fields stripped)
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
| GraphQL client | `src/scraper/graphql-client.ts` |
| Per-plugin rate limiting | `src/scraper/throttle.ts` |
| Scraper error hierarchy (includes recon-only `StepVerificationError`) | `src/scraper/errors.ts` |
| Drift-detection metrics | `src/scraper/metrics.ts` |
| Static fixture loader | `src/scraper/fixtures.ts` |
| Response cache + coalescing | `src/cache/response-cache.ts` |
| Pino logger + CloudWatch splitting | `src/lib/logging.ts` |
| Environment variable parsers | `src/lib/env.ts` |
| AWS Bedrock model factory | `src/lib/bedrock.ts` |
| Prisma client singleton | `src/lib/db/client.ts` |
| Phase 1 — browser recon | `src/scripts/recon-browser.ts` |
| Phase 2–3 — HTTP replay + probes | `src/scripts/recon-http.ts` |
| Phase 4f — plugin skeleton generator | `src/scripts/recon-generate.ts` |
| Phase 4e — findings doc generator | `src/scripts/recon-summarize.ts` |
| Shared recon types + utilities (`CAPTURES_DIR`, `STEP_FAILURES_DIR`) | `src/scripts/recon-shared.ts` |
| Smoke test | `src/scripts/smoke-test.ts` |
| Plugin contract interface (template for all site plugins) | `src/site-plugin.ts` |
| Findings doc (generated) | `docs/target-recon.md` |
