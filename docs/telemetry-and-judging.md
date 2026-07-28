# Barnacle Telemetry & LLM Judging — Concept Guide

> This document explains *why* Barnacle captures LLM call telemetry and runs
> a judge over it — the design intent behind each layer, the three-dimensional
> accuracy rubric, and what a verdict artifact contains. It is the concept
> companion to the operator runbook in [playbook.md](./playbook.md).

---

## Why capture at all?

Barnacle's recon pipeline and its healing cascades make LLM calls at several
points: rephrasing a stuck flow step, replanning the remaining tail after a
terminal failure, proposing a patch to a failed flow step, and proposing a
patch to a failing LLM prompt template. These calls are invisible at runtime
— they succeed or silently degrade, and there is no natural signal that the
model's output quality has shifted.

Structured telemetry solves this. Every LLM call site appends one NDJSON line
to a shared sink (`src/lib/telemetry/call-capture.ts`, path configured by
`CALLS_NDJSON_PATH`, default `.barnacle/calls.ndjson`). The file is append-only
so captures survive process restarts; the sink swallows write errors rather than
interrupting the call site. Operators run the judge skill against the accumulating
file on a cadence that fits their recon frequency — weekly for active sites,
before and after any prompt-template change.

Local NDJSON survives process restarts but not container replacement — an ECS
task swap discards the disk. The optional buffered S3 sink
(`src/lib/telemetry/s3-sink.ts`) mirrors both the calls and submissions NDJSON
streams to object storage so captures survive that case too; it is entirely
inert until `TELEMETRY_S3_BUCKET` is set (see the Telemetry env var table in
[README.md](../README.md#telemetry)).

**The goal is an evidence base, not a dashboard.** The verdict JSON is a diffable
artifact in `judge-out/`. When a prompt change is proposed or a model upgrade is
considered, the operator runs the judge against both the old and new configuration
and compares the aggregate pass rates. The captures are the ground truth; the
verdicts are the measurement.

---

## What is captured?

Each captured sample (`LlmCallSample`, defined in
`src/api/schemas/telemetry.ts`) carries:

| Field | Meaning |
|-------|---------|
| `callId` | UUID assigned at call time — ties a sample to its verdict entry |
| `callType` | Which LLM call site produced this sample (see below) |
| `model` | Model string used for the call |
| `systemPrompt` | System prompt text, or `null` if none was provided |
| `userContent` | The full user-turn content sent to the model |
| `responseContent` | Raw response text, or `null` if the call threw |
| `parsedOk` | `true` if the response was parseable as the expected schema |
| `inputTokens` | Token count from the API response, or `null` |
| `outputTokens` | Token count from the API response, or `null` |
| `latencyMs` | Wall-clock milliseconds from request to response, or `null` |
| `success` | `true` if the call site accepted and used the response |
| `ts` | ISO-8601 timestamp when the line was written |

### Call types

The four LLM call sites Barnacle owns are named by constants in
`src/lib/telemetry/call-types.ts`:

| Constant | `callType` string | When it fires |
|----------|-------------------|---------------|
| `CALL_TYPE_RECON_REPHRASE` | `recon-rephrase` | Attempt 4 of the per-step self-healing cascade — asks the LLM to rephrase a stuck flow step before retrying it via Stagehand. |
| `CALL_TYPE_RECON_REPLAN` | `recon-replan` | After a step terminally fails — asks the LLM to rewrite the remaining tail of the recon flow given the failure context. |
| `CALL_TYPE_RECON_FLOW_PATCH` | `recon-flow-patch` | The `recon-heal` script (`pnpm recon:heal`) — asks the LLM to propose a minimal `{anchor, replacement}` edit to `recon-flow.json`. |
| `CALL_TYPE_LLM_PROMPT_PATCH` | `llm-prompt-patch` | The `llm-heal` script (`pnpm heal:llm`) — asks the LLM to propose a minimal edit to an LLM prompt template whose captured outputs are failing judge review. |

Callers reference these constants rather than magic strings, so renaming a
call type stays a one-file change.

---

## The three-dimensional judging rubric

The judge skill (`judge-llm-batch`, invoked via `pnpm judge:llm`) scores each
captured sample on three boolean dimensions. A sample passes only when all
three are `true`.

### 1. Schema adherence (`schemaOk`)

**Question:** Did the model's response match the expected output structure for
this `callType`?

`true` when `responseContent` is valid JSON whose shape conforms to the
call type's expected contract — for example, `recon-rephrase` expects a plain
string, `recon-flow-patch` expects `{anchor, replacement, strategy, pivot_reason}`.

`false` when the response is malformed JSON, missing required fields, or has
an unexpected shape. If the sample's own `parsedOk` field is `false` — meaning
the call site itself could not parse the response — the judge automatically
marks `schemaOk = false` regardless of what the model returns.

### 2. Factual grounding (`factuallyGrounded`)

**Question:** Are all factual claims in the response consistent with the context
provided in `userContent`?

`true` when the model's output is consistent with the page context, error dumps,
observe candidates, and other grounding material included in the user turn.
`false` when the response contradicts or ignores facts explicitly present in
the prompt — for example, a rephrase that targets a DOM element the observe
candidates show is absent, or a replan that ignores the list of already-completed
steps.

### 3. Hallucination-freeness (`hallucinationFree`)

**Question:** Does the response avoid inventing information not implied by the
prompt?

`true` when the output contains no fabricated URLs, selector strings, field
names, or other values that were not grounded in the user-turn content.
`false` when the model invents specifics — a plausible-looking but non-existent
GraphQL field, a selector that does not appear in the observe candidates, a
URL that was not mentioned in the page context.

### Aggregate pass

`pass = schemaOk && factuallyGrounded && hallucinationFree`.

The aggregate counts (`schemaPass`, `factualPass`, `hallucinationFreePass`,
`overallPass`) let operators identify which dimension is the primary failure
mode before deciding on a prompt-template change.

---

## The verdict artifact

The judge writes one verdict JSON file per `(callType, batchIndex)` pair to
`judge-out/` (configurable via `--out-dir`). The file name is
`verdict-<callType>-<batchIndex>.json` and its schema is `judgeVerdictSchema`
(`src/api/schemas/telemetry.ts`):

```json
{
  "callType": "recon-rephrase",
  "batchIndex": 0,
  "judgedAt": "2026-05-30T14:00:00.000Z",
  "judgeModel": "claude-sonnet-4-6",
  "verdicts": [
    {
      "callId": "a1b2c3d4-...",
      "schemaOk": true,
      "schemaRationale": "response is a plain non-empty string as expected",
      "factuallyGrounded": true,
      "factualRationale": "rephrased instruction matches the observe candidates provided",
      "hallucinationFree": false,
      "hallucinationRationale": "response references a selector not present in the candidates list",
      "worstOffender": "#login-submit-btn",
      "pass": false
    }
  ],
  "aggregate": {
    "n": 12,
    "schemaPass": 12,
    "factualPass": 10,
    "hallucinationFreePass": 9,
    "overallPass": 9
  }
}
```

`worstOffender` is optional — the judge sets it when it can identify the
specific text fragment most responsible for a failure, making the self-heal
skill's patch generator more precise.

---

## The self-heal loop

When the aggregate pass rate falls below a threshold (default 90%, configurable
via `SELFHEAL_SUCCESS_THRESHOLD`), the self-heal skill (`llm-self-heal`, invoked
via `pnpm heal:llm`) runs an iterative patch-and-replay loop:

1. **Baseline** — replay the failing samples against the current prompt
   template and record the pass rate.
2. **Patch** — ask the `llm-call-patch-generator` subagent to propose a
   minimal `{anchor, replacement}` edit to the prompt template based on the
   failing examples and any prior iteration history.
3. **Replay** — apply the patch and re-score the failing samples `N` times
   (default 5) to account for LLM non-determinism.
4. **Converge** — check against `successThreshold`, plateau detection
   (`plateauDelta`, `plateauWindow`), and iteration budget (`maxIterations`).

The loop writes per-iteration artifacts to `llm-heal-out/<callType>/iter-N/`
and a final `healing-<callType>.md` report with the best patch and iteration
history. **Production prompt templates in `src/` are never modified automatically.**
The operator applies the best patch manually after reviewing the report.

Convergence verdicts: `SUCCESS` (threshold met), `PLATEAUED` (no meaningful
improvement across `plateauWindow` consecutive iterations), `BUDGET_EXHAUSTED`
(hit `maxIterations` without converging), `REGRESSED` (pass rate fell below
baseline).

---

## Configuration reference

All telemetry and judging knobs are in `src/config.ts` under the `telemetry`,
`judging`, and `selfheal` namespaces:

| Env var | Default | Meaning |
|---------|---------|---------|
| `TELEMETRY_ENABLED` | `true` | Master switch — set `false` to disable all NDJSON writes |
| `CALLS_NDJSON_PATH` | `.barnacle/calls.ndjson` | Append-only call capture file |
| `SUBMISSIONS_NDJSON_PATH` | `.barnacle/submissions.ndjson` | Append-only submission-envelope file |
| `TELEMETRY_EVENTS_DIR` | `.barnacle/events` | Per-run event-stream directory |
| `TELEMETRY_MAX_FILE_SIZE_BYTES` | 100 MB | Rotate/drop threshold for the calls file |
| `TELEMETRY_MAX_RETENTION_MS` | 30 days | Event-stream file retention |
| `JUDGE_MODEL` | `us.anthropic.claude-sonnet-4-6[1m]` | Model used by the judge |
| `JUDGE_TEMPERATURE` | `0.2` | Scoring temperature (lower = more deterministic) |
| `JUDGE_BATCH_SIZE` | `10` | Samples per LLM judge request |
| `JUDGE_TIMEOUT_MS` | `120 000` | Per-request timeout for judge calls |
| `SELFHEAL_MAX_ITERATIONS` | `5` | Iteration cap before BUDGET_EXHAUSTED |
| `SELFHEAL_N_REPLAYS` | `5` | Replay runs per iteration arm |
| `SELFHEAL_SUCCESS_THRESHOLD` | `0.9` | Pass-rate target |
| `SELFHEAL_PLATEAU_WINDOW` | `3` | Consecutive flat iterations to trigger PLATEAUED |
| `SELFHEAL_PLATEAU_DELTA` | `0.03` | Minimum meaningful pass-rate improvement |
| `SELFHEAL_TIMEOUT_MS` | `60 000` | Per-replay LLM request timeout |

### Session-IP capture knobs

The submit record's `session.ip` (and the beacon record's `sessionIp`) are
gated by knobs under `src/config.ts`'s `scraper` namespace, not `telemetry` —
they govern the browser-session echo navigation, not the NDJSON sink itself:

| Env var | Default | Meaning |
|---------|---------|---------|
| `SCRAPER_CAPTURE_SESSION_IP` | `true` | Master switch for the outbound-IP echo navigation; `false` yields `session: null` / `sessionIp: null` everywhere without touching the rest of the submit/beacon record. |
| `SCRAPER_SESSION_IP_ECHO_URL` | `https://api.ipify.org?format=json` | The IP-echo endpoint the session's own short-lived tab navigates to. Operators can point this at a self-hosted echo endpoint. |
| `SCRAPER_SESSION_IP_TIMEOUT_MS` | `10 000` | Watchdog bound on the echo navigation; a page that never resolves is cut off and yields `null` rather than blocking the submission. |

---

## Submission-envelope sink

A separate append-only NDJSON file, `.barnacle/submissions.ndjson`
(`SUBMISSIONS_NDJSON_PATH`), is the canonical reconciliation record — the
durable, queryable answer to "what did we submit for jobId X on date Y, did
it succeed, and did the conversion beacon fire?" Two record kinds share the
sink, discriminated by `kind`
(`reconciliationRecordSchema`, `src/lib/telemetry/reconciliation-record.ts`).

Kept on its own sink (not mixed into `calls.ndjson`) so the judge and
self-heal readers — which Zod-parse every line of `calls.ndjson` as an
`LlmCallSample` — stay untouched.

### `"submit"` records — one per dispatch outcome

Written by `captureSubmissionEnvelope` (`src/lib/telemetry/submission-capture.ts`)
and validated against `submitRecordSchema`, exported from that module as
`submissionEnvelopeSampleSchema`. Every key of the schema:

| Field | Meaning |
|-------|---------|
| `kind` | Always `"submit"`; defaults to `"submit"` so pre-existing lines written before this field existed still parse. |
| `siteId` | Which plugin handled the request — the cohort dimension for reconciliation. |
| `requestId` | The Fastify-issued correlation ID for the inbound request; joins a `"beacon"` record to this one. |
| `joinKeys` | Opaque `Record<string, unknown> \| null` — the plugin's own `extractJoinKeys` hook resolved from the inbound payload, merged with any fields the plugin attached mid-run via `context.telemetry.addJoinKeys()` (run-discovered keys win on collision). Core never inspects its contents; `null` when neither source produced anything. |
| `inboundPayload` | The request body the caller posted, unredacted (`z.unknown()` — no shape is enforced on it). |
| `status` | Submit outcome: `"submitted"` or `"error"`. |
| `auditPayload` | The same object plugins return via `SitePluginResult.auditPayload`; `null` on errors. Plugins that need to keep PII out of the sink redact it here, not on `inboundPayload`. |
| `errorMessage` | The failure message on errors; `null` on success. |
| `durationMs` | Total dispatch wall time. |
| `ts` | ISO timestamp. |
| `session` | `{ id, provider, ip, ipCapturedAt } \| null` — identity of the Browserbase session that served this run. `null` only on the direct-HTTP hot path (`executeHttp`, no session ever acquired). Once a session is acquired, `id`/`provider` are always populated; `ip`/`ipCapturedAt` fall back to `null` when the provider exposes no outbound-IP accessor (Steel) or when session-IP capture is disabled (see [Configuration reference](#configuration-reference)). |

`joinKeys` is populated from two sources merged together: the plugin's own
`extractJoinKeys` hook (`src/site-plugin.ts`), resolved once from the inbound
payload, and `context.telemetry.addJoinKeys()` — a mid-run attach point on
`SitePluginContext` backed by a per-dispatch `RunTelemetry`
(`src/lib/telemetry/run-telemetry.ts`) that a plugin can call at any point
during `execute()`/`executeHttp()` to attach a field it only discovers during
the run (something read from the page, a token minted mid-flow, a value
observed on a response) — something `extractJoinKeys` cannot do since it only
ever sees the pre-run payload. `dispatch()` (`src/plugins/loader.ts`), the
sink's only production call site, calls `plugin.extractJoinKeys?.(payload) ?? null`
once per dispatch, then merges the collector's snapshot over it (run-discovered
keys win on collision) on both the success and error envelope paths —
`null` when neither source produced anything.

`session` is stamped by the same `dispatch()` call site: once per dispatch,
in a `finally` around the plugin's session-scoped work, core best-effort
awaits the acquired `BrowserSession`'s optional `getOutboundIp()` accessor
(`src/scraper/session-shared.ts`) and records `{ id: session.sessionId,
provider: session.provider, ip, ipCapturedAt }` — `session` itself is only
`null` when no `BrowserSession` was ever acquired (the `executeHttp` hot
path). `getOutboundIp()` is itself a memoized wrapper
(`src/scraper/session-browserbase.ts`) around `resolveSessionOutboundIp`
(`src/scraper/session-ip.ts`), which opens a separate, short-lived tab and
navigates it to an IP-echo endpoint — the only way to learn a Browserbase
session's actual outbound IP, since neither the Browserbase SDK nor
`BrowserSession` otherwise exposes it. It never throws: capture failures,
timeouts, a missing accessor (Steel), and a disabled capture flag all yield
`ip`/`ipCapturedAt: null` within an otherwise-populated `session` block,
rather than interrupting the submission.

### `"beacon"` records — the conversion/beacon-fire dimension, distinct from submit `status`

Written by `captureBeaconEvent` (`src/lib/telemetry/beacon-capture.ts`) and
validated against `beaconEventSchema`. For a plugin with no `extractJoinKeys`,
appended independently, strictly later than its matching `"submit"` record,
once `fireTrackingClick` (`src/lib/tracking-click.ts`) resolves the vendor
click-tracking navigation core drove itself. A plugin that declares
`extractJoinKeys` (and so manages its own beacon nav) can instead call
`context.recordBeaconOutcome` — bound to the run's `requestId`/`siteId` by
`buildPluginContext` (`src/plugins/loader.ts`) — once its own navigation
resolves, giving it the same ability to report a real outcome. Every key:

| Field | Meaning |
|-------|---------|
| `kind` | Always `"beacon"`. |
| `requestId` | Joins this record back to its `"submit"` record. |
| `siteId` | Same cohort dimension as the submit record. |
| `joinKeys` | Two writers, not one. For a `fireTrackingClick`-written line: the same merged `extractJoinKeys`/`context.telemetry.addJoinKeys()` bag as the submit record, threaded through by the caller. For a `context.recordBeaconOutcome`-written line: exactly the bag the plugin passes as `input.joinKeys` — `createBeaconOutcomeRecorder` forwards it to `captureBeaconEvent` verbatim, with no merge against the run's submit-side bag and no interpretation by core. Either way, the folded row `GET /v1/submissions` returns takes `joinKeys` from the submit line only — `foldReconciliationRecords` copies just `beaconStatus`/`trackingUrl`/`ts`/`durationMs` off the winning beacon line — so a beacon line's own `joinKeys` bag is readable only from raw NDJSON. |
| `beaconStatus` | `"fired"`, `"failed"`, or `"skipped"` — the conversion/beacon-fire outcome, a field distinct from the submit record's `status`. This is what makes "submitted but the beacon did not fire" measurable, where previously `fireTrackingClick` was fire-and-forget with errors swallowed and only Datadog counters (`recordTrackingClickSuccess`/`recordTrackingClickFailure`) as evidence. `"skipped"` covers two distinct reasons, distinguished by `trackingUrl` below: no beacon was ever applicable for the run (no usable `TrackingUrl` — `trackingUrl: null`), or the plugin declared `extractJoinKeys` and so fires its own beacon nav outside `dispatch()` even though a `TrackingUrl` was present (`trackingUrl` carries the real, truncated URL). Either way `"skipped"` is distinct from `"not_fired"` below (no beacon line arrived at all). If that self-managing plugin later calls `context.recordBeaconOutcome` to report a real `fired`/`failed` outcome for the same `requestId`, that line always outranks the earlier `"skipped"` line when folded, regardless of write order. |
| `trackingUrl` | The vendor click-tracking URL, truncated to 120 characters; `null` when none was present. For a `"skipped"` record this doubles as the two-reasons signal above — present means a URL existed but a plugin-owned navigation used it instead of core's `fireTrackingClick`. |
| `durationMs` | Wall time of the tracking-click navigation itself, not the original dispatch. |
| `ts` | ISO timestamp. |
| `sessionIp` | `string \| null`, defaulted so historical beacon lines without this key still parse. The outbound IP of `fireTrackingClick`'s own short-lived Browserbase session (`src/lib/tracking-click.ts`) — a **different** session than the one that served the original submit, so it can (and often will) carry a different IP than the submit record's `session.ip`. Resolved the same way (`getOutboundIp()`), and only present on `"fired"`/`"failed"` records; `null` on `"skipped"` records, since no engine-driven tracking-click session ever opens in that case. |

A `"fired"`/`"failed"` `"beacon"` record is written by either of two
sources. The first is `fireTrackingClick`, when its caller supplies a
`TrackingClickReconciliationContext` (`requestId` plus `joinKeys`) — the
parameter is optional so existing call sites keep compiling. `dispatch()`'s
call site supplies one on every tracking click it fires (i.e. only for a
plugin with no `extractJoinKeys`), threading the same `joinKeys` bag it
resolved for the submit record. The second is
`context.recordBeaconOutcome` (`SitePluginContext`, bound to the run's
`requestId`/`siteId` by `buildPluginContext` in `src/plugins/loader.ts`) —
a plugin-callable wrapper around `createBeaconOutcomeRecorder`
(`src/lib/telemetry/beacon-capture.ts`), which a plugin that declares
`extractJoinKeys` calls once its own beacon navigation resolves, to report
the real outcome that `dispatch()` otherwise records as `"skipped"`. Like
`captureBeaconEvent`, it never throws — errors are logged and swallowed.
It defaults an omitted `trackingUrl`/`durationMs` to `null`/`0`, the same
values `dispatch()`'s own `"skipped"` write uses. A `"skipped"` `"beacon"`
record is written by `dispatch()` itself, via the same `captureBeaconEvent`,
when a successful submit's payload has no (or an empty-string)
`TrackingUrl`, OR when the plugin declared `extractJoinKeys` (asserting it
manages its own tracking nav) — `durationMs: 0` since no engine-driven
tracking-click navigation ever ran in either case. The write path is
additionally exercised directly by `beacon-capture.test.ts`.

### Reading, filtering, and querying reconciliation rows

`readReconciliationRows` (`src/lib/telemetry/submission-reader.ts`) reads the
sink and left-joins `"beacon"` records onto their `"submit"` record by
`requestId`, producing one `ReconciliationRow` per run with a `beaconStatus`
of `"fired"`, `"failed"`, `"skipped"`, or `"not_fired"` — the sink writes the
first three; `"not_fired"` is synthesized by the reader when no beacon line
ever arrived for a submit row. When more than one `"beacon"` line shares a
`requestId` — e.g. `dispatch()`'s synchronous `"skipped"` write for a
self-managing plugin followed by that plugin's own later-recorded real
outcome — a real `"fired"`/`"failed"` line always outranks `"skipped"`
regardless of write order; among equal-rank lines the later one wins. `GET
/v1/submissions` instead
composes `readDurableReconciliationRows`
(`src/lib/telemetry/reconciliation-source.ts`), which unions the local
sink's raw records with its S3-mirrored records (the buffered S3 sink
described above), dedupes exact duplicates, and folds the result the same
way `readReconciliationRows` does — so a submit line written by one ECS
task and its beacon line written by another still land in one row.
`queryReconciliationRows`
(`src/lib/telemetry/submission-query.ts`) then filters/sorts (newest-first)/
paginates those rows by `siteId`, `requestId`, `status`, `beaconStatus`, or a
`from`/`to` window — the fields every reconciliation query needs regardless
of plugin. `joinKeys`-specific filtering is not offered at this layer, since
core doesn't know its shape; a caller filters on `joinKeys` client-side, or
narrows by `siteId`/`requestId` first. Both are composed behind
`GET /v1/submissions` (authenticated; `src/api/routes/submissions.ts`,
querystring/response schemas in `src/api/schemas/submissions.ts`) — the
queryable HTTP path for a plugin to join runs against its own attribution
provider's report without re-parsing raw NDJSON. The response row omits
`inboundPayload`/`auditPayload` (the opaque blobs this route exists to stop
callers from having to re-parse) and renames the reader's internal
`beaconTrackingUrl` field to `trackingUrl`. The submit record's `session`
block folds and serializes through unchanged, while the beacon record's
`sessionIp` is renamed to `beaconSessionIp` (both on `ReconciliationRow`
and on `reconciliationRowSchema`, derived off
`beaconEventSchema.shape.sessionIp` rather than restated) so it reads as
distinct from the submit line's own `session.ip` on the wire — the two are
separate Browserbase sessions per run. `ReconciliationRow` and
`reconciliationRowSchema` otherwise derive from
`submitRecordSchema`/`beaconEventSchema` rather than restating fields, so
a caller comparing runs against a third-party report's IP column reads
`session.ip` (and, separately, the beacon's own `beaconSessionIp`) straight
off `GET /v1/submissions` without re-parsing raw NDJSON.

## File map

| Concern | File |
|---------|------|
| NDJSON capture sink + `LlmCallSample` type | `src/lib/telemetry/call-capture.ts` |
| Submission-envelope sink + `SubmissionEnvelopeSample` type | `src/lib/telemetry/submission-capture.ts` |
| Reconciliation record schemas (`submit` + `beacon` kinds) | `src/lib/telemetry/reconciliation-record.ts` |
| Beacon-fire (conversion) event writer + `BeaconEventSample` type | `src/lib/telemetry/beacon-capture.ts` |
| Plugin-callable beacon-outcome recorder | `createBeaconOutcomeRecorder` in `src/lib/telemetry/beacon-capture.ts`, bound onto `SitePluginContext.recordBeaconOutcome` by `buildPluginContext` in `src/plugins/loader.ts` |
| Plugin-owned join-key extraction hook | `SitePlugin.extractJoinKeys` in `src/site-plugin.ts` |
| Mid-run join-key attach point + per-dispatch collector | `SitePluginContext.telemetry` in `src/site-plugin.ts`, `RunTelemetry` in `src/lib/telemetry/run-telemetry.ts` |
| Browser-session outbound-IP resolver | `src/scraper/session-ip.ts` |
| Reconciliation reader (`readReconciliationRows`) | `src/lib/telemetry/submission-reader.ts` |
| Durable (local+S3) reconciliation source (`readDurableReconciliationRows`) | `src/lib/telemetry/reconciliation-source.ts` |
| Reconciliation query/filter layer (`queryReconciliationRows`) | `src/lib/telemetry/submission-query.ts` |
| `GET /v1/submissions` route + querystring/response schemas | `src/api/routes/submissions.ts`, `src/api/schemas/submissions.ts` |
| Call-type string constants | `src/lib/telemetry/call-types.ts` |
| `llmCallSampleSchema`, `judgeVerdictSchema` | `src/api/schemas/telemetry.ts` |
| Judge batch script (`pnpm judge:llm`) | `src/scripts/judge-llm-batch.ts` |
| Self-heal loop (`pnpm heal:llm`) | `src/scripts/llm-heal.ts` |
| Telemetry + judging + selfheal config | `src/config.ts` |
| Per-run event-stream state | `src/lib/telemetry/run-state.ts` |
