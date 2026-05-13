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
recon reruns in ~90 seconds unattended and produces a fresh diff. The
committed captures are the source of truth; `git log` on a capture file tells
you exactly when the target's shape last changed.

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

### Why a 90-second hard timeout

A hung Stagehand operation — frozen CDP connection, infinite network wait,
a `page.goto` that never resolves — would hold a `p-queue` concurrency slot
indefinitely without this. The timeout converts a silent hang into
`SessionTimeoutError`, which the retry policy can act on by closing the
broken session and creating a fresh one.

20 seconds is enough for a normal page load + LLM inference. 90 seconds
gives ample headroom for slow sites while still bounding the blast radius
of a pathological hang.

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
| `CaptchaError` | Abort immediately | A CAPTCHA requires human intervention. Burning more sessions won't help — it makes the IP look more like a bot. Surface immediately. |
| `EmptyResultsError` | Abort immediately | Empty results are a query-shape bug, not a transient failure. Retrying the same malformed query will always return empty. Fix the query. |
| `SessionTimeoutError` | Kill session → create fresh → retry up to `maxAttempts` | The session itself is corrupted (hung CDP, stale context). `onSessionRestart` is invoked at most once (a `done` flag prevents double-restart), then p-retry continues the normal attempt budget. |
| `SelectorFailureError` | Retry up to `maxAttempts` with backoff | Stagehand cache may have a stale selector. Retry forces LLM re-resolution. Usually recovers in 1–2 retries. |
| `UnknownScraperError` | Retry up to `maxAttempts` | Catch-all for transient network or Playwright errors. Exponential backoff with jitter prevents retry storms. |

Hot-path → fallback decision (in `dispatch()`):

| Hot-path error | Triggers browser fallback? | Reason |
|---------------|--------------------------|--------|
| `HttpSchemaError` | Yes | Response shape drifted; browser may still return the right data via DOM extraction |
| `HttpBotChallengeError` | Yes | 401/403 from edge; residential proxy in the browser session may get through |
| `HttpServerError` | Yes | 5xx; recovery strategy is the same regardless of path |
| `HttpRateLimitError` | **No** | 429 means back off — burning a Steel session against a rate-limited endpoint just costs money and burns the session |

---

## What protects you before the change is visible

**Zod at the boundary.** The moment a response stops matching your schema,
the request fails loudly rather than silently returning garbage data
downstream. This is the single most important defensive measure. Schema drift
is caught at the first request, not when a downstream consumer complains.

**Stagehand fallback is always hot.** You don't have to build a fallback when
the hot path dies — it already exists and is always deployed. Site changes
degrade cost and latency, not availability.

**LLM-selector cache self-heals.** When the DOM shifts, the first Stagehand
cache miss triggers Claude to re-resolve the selector from natural-language
description. The fallback self-heals for small UI changes without human
intervention.

**Committed artifacts make the diff trivial.** `git log` on the captured
query file tells you exactly when the target's shape last changed. You're
never guessing what changed or when — you have a diffable capture archive.

**Nightly smoke test fails fast.** The smoke test validates a real response
against the full Zod schema nightly. Schema drift surfaces at 03:00, not at
10:00 when users start calling the API.

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
- `recon:browser` reruns in ~90 seconds unattended.
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
| Scraper error hierarchy | `src/scraper/errors.ts` |
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
| Shared recon types + utilities | `src/scripts/recon-shared.ts` |
| Smoke test | `src/scripts/smoke-test.ts` |
| Example plugin contract | `src/sites/example/contract.ts` |
| Example browser flow | `src/sites/example/flows/browser-flow.ts` |
| Findings doc (generated) | `docs/target-recon.md` |
