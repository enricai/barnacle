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
— they succeed or silently degrade, with no natural signal that output
quality has shifted.

Structured telemetry solves this. Every LLM call site appends one NDJSON line
to a shared, append-only sink (`src/lib/telemetry/call-capture.ts`, path
configured by `CALLS_NDJSON_PATH`, default `.barnacle/calls.ndjson`) that
swallows write errors rather than interrupting the call site. Operators run
the judge skill against the accumulating file on a cadence that fits their
recon frequency — weekly for active sites, before and after any
prompt-template change.

Local NDJSON survives process restarts but not container replacement — an
ECS task swap discards the disk. The optional buffered S3 sink
(`src/lib/telemetry/s3-sink.ts`) replicates both the calls and submissions
NDJSON streams to object storage so captures survive that case too; it is
inert until `TELEMETRY_S3_BUCKET` is set (see the
[Configuration reference](#configuration-reference) below).

**The goal is an evidence base, not a dashboard.** The verdict JSON is a
diffable artifact in `judge-out/`. When a prompt change is proposed or a
model upgrade is considered, the operator runs the judge against both the
old and new configuration and compares the aggregate pass rates. The
captures are the ground truth; the verdicts are the measurement.

---

## What is captured?

Each captured sample (`LlmCallSample`, defined in
`src/lib/telemetry/call-capture.ts` and re-exported via
`src/api/schemas/telemetry.ts`) records the call's identity (`callId`,
`callType`, `model`), its prompt and response (`systemPrompt`,
`userContent`, `responseContent`, `parsedOk`), timing and cost
(`inputTokens`, `outputTokens`, `latencyMs`), and outcome (`success`,
`errorMessage`, `failureKind`, `ts`). `failureKind` is one of
`"anthropic-billing"`, `"anthropic-rate-limit"`, `"anthropic-other"`,
`"schema-validation-failed"`, `"response-empty"`, or `"exception-other"` —
`null` on success.

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

Did the model's response match the expected output structure for this
`callType`? `true` when `responseContent` is valid JSON conforming to the
call type's contract — e.g. `recon-rephrase` expects a plain string,
`recon-flow-patch` expects `{anchor, replacement, strategy, pivot_reason}`.
If the sample's own `parsedOk` is `false`, the judge marks `schemaOk = false`
regardless of what the model returned.

### 2. Factual grounding (`factuallyGrounded`)

Are all factual claims in the response consistent with the context provided
in `userContent`? `false` when the response contradicts or ignores facts
present in the prompt — e.g. a rephrase targeting a DOM element the observe
candidates show is absent, or a replan ignoring already-completed steps.

### 3. Hallucination-freeness (`hallucinationFree`)

Does the response avoid inventing information not implied by the prompt?
`false` when the model invents specifics not grounded in the user-turn
content — a fabricated GraphQL field, a selector absent from the observe
candidates, an unmentioned URL.

### Aggregate pass

`pass = schemaOk && factuallyGrounded && hallucinationFree`. The aggregate
counts (`schemaPass`, `factualPass`, `hallucinationFreePass`, `overallPass`)
let operators identify which dimension is the primary failure mode before
deciding on a prompt-template change.

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

When the aggregate pass rate falls below a threshold (default 90%,
configurable via `SELFHEAL_SUCCESS_THRESHOLD`), `llm-self-heal`
(`pnpm heal:llm`) runs an iterative patch-and-replay loop:

1. **Baseline** — replay the failing samples against the current prompt
   template and record the pass rate.
2. **Patch** — ask the `llm-call-patch-generator` subagent to propose a
   minimal `{anchor, replacement}` edit based on the failing examples and
   any prior iteration history.
3. **Replay** — apply the patch and re-score the failing samples `N` times
   (default 5) to account for LLM non-determinism.
4. **Converge** — check against `successThreshold`, plateau detection
   (`plateauDelta`, `plateauWindow`), and iteration budget (`maxIterations`).

The loop writes per-iteration artifacts to `llm-heal-out/<callType>/iter-N/`
and a final `healing-<callType>.md` report with the best patch and iteration
history. **Production prompt templates in `src/` are never modified
automatically** — the operator applies the best patch manually after
reviewing the report.

Convergence verdicts: `SUCCESS` (threshold met), `PLATEAUED` (no meaningful
improvement across `plateauWindow` consecutive iterations),
`BUDGET_EXHAUSTED` (hit `maxIterations` without converging), `REGRESSED`
(pass rate fell below baseline).

---

## Configuration reference

All telemetry and judging knobs are in `src/config.ts` under the
`telemetry`, `judging`, and `selfheal` namespaces:

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
gated by knobs under `src/config.ts`'s `scraper` namespace, not `telemetry`
— they govern the browser-session echo navigation, not the NDJSON sink
itself:

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
(`reconciliationRecordSchema`, `src/lib/telemetry/reconciliation-record.ts`):
a `"submit"` record per dispatch outcome, and a `"beacon"` record for the
conversion/beacon-fire dimension, which is distinct from the submit
record's `status`.

Kept on its own sink (not mixed into `calls.ndjson`) so the judge and
self-heal readers — which Zod-parse every line of `calls.ndjson` as an
`LlmCallSample` — stay untouched.

For the full field-by-field schema of both record kinds, how `joinKeys` is
merged from `extractJoinKeys` and `context.telemetry.addJoinKeys()`, how
`session`/`sessionIp` are captured, and how rows are read, filtered, and
queried via `GET /v1/submissions`, see the operator runbook:
[submission-reconciliation.md](./submission-reconciliation.md).
