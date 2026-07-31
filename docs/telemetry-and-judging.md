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

---

## Submission-envelope sink

A separate append-only NDJSON file, `.barnacle/submissions.ndjson`, captures
one record per dispatch outcome — the durable answer to "what did we submit
for jobId X on date Y, and did it succeed?" Each line carries:

- `siteId` — which plugin handled the request.
- `requestId` — the Fastify-issued correlation ID for the inbound request.
- `inboundPayload` — the request body the caller posted (PII-redacted).
- `status` — `"submitted"` or `"error"`.
- `auditPayload` — the same object plugins return via `SitePluginResult.auditPayload`; `null` on errors.
- `errorMessage` — the failure message on errors; `null` on success.
- `durationMs` — total dispatch wall time.
- `ts` — ISO timestamp.

Kept on its own sink (not mixed into `calls.ndjson`) so the judge and
self-heal readers — which Zod-parse every line of `calls.ndjson` as an
`LlmCallSample` — stay untouched. Downstream consumption (querying by
jobId, aggregating by site, replaying a payload) is an ETL concern; the
file is the durable source-of-truth those pipelines read from.

## File map

| Concern | File |
|---------|------|
| NDJSON capture sink + `LlmCallSample` type | `src/lib/telemetry/call-capture.ts` |
| Submission-envelope sink + `SubmissionEnvelopeSample` type | `src/lib/telemetry/submission-capture.ts` |
| Call-type string constants | `src/lib/telemetry/call-types.ts` |
| `llmCallSampleSchema`, `judgeVerdictSchema` | `src/api/schemas/telemetry.ts` |
| Judge batch script (`pnpm judge:llm`) | `src/scripts/judge-llm-batch.ts` |
| Self-heal loop (`pnpm heal:llm`) | `src/scripts/llm-heal.ts` |
| Telemetry + judging + selfheal config | `src/config.ts` |
| Per-run event-stream state | `src/lib/telemetry/run-state.ts` |
