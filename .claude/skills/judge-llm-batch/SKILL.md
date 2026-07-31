---
name: judge-llm-batch
description: "Apply a 3-dimensional accuracy rubric (schema adherence, factual accuracy, hallucination-freeness) to a batch of Barnacle LLM call captures and write verdict JSON. Used to measure whether a Barnacle LLM call site (recon-rephrase, recon-replan, recon-flow-patch, llm-prompt-patch) is producing accurate output under its prompt contract. Runs via `pnpm run judge:llm`."
argument-hint: "<path-to-calls.ndjson> --call-type <type> [--batch-index <N>] [--judge-model <model>] [--out-dir <path>] [--dry-run]"
allowed-tools:
  - Read
  - Write
  - Bash
---

<objective>
Read Barnacle LLM call captures from a `calls.ndjson` telemetry file (one
JSON object per line, written to `.barnacle/calls.ndjson` by default), filter
by `callType`, evaluate every sample against a 3-dimensional rubric, and write
a verdict JSON file via the `pnpm run judge:llm` script.

The verdict file is written to `judge-out/verdict-<callType>-<batchIndex>.json`.

Output shape (camelCase to match Barnacle conventions):

```json
{
  "callType": "<from filter>",
  "batchIndex": 0,
  "judgedAt": "<ISO-8601>",
  "judgeModel": "claude-sonnet-4-6",
  "verdicts": [
    {
      "callId": "<UUID from the capture>",
      "schemaOk": true,
      "schemaRationale": "<one sentence>",
      "factuallyGrounded": true,
      "factualRationale": "<one sentence>",
      "hallucinationFree": true,
      "hallucinationRationale": "<one sentence>",
      "worstOffender": "<optional — 1-line quote when any dimension failed>",
      "pass": true
    }
  ],
  "aggregate": {
    "n": 0,
    "schemaPass": 0,
    "factualPass": 0,
    "hallucinationFreePass": 0,
    "overallPass": 0
  }
}
```

`pass` is `true` only when all three dimensions are `true`.
</objective>

<execution_context>
Arguments parsed from `$ARGUMENTS`:
- First positional: path to `calls.ndjson` (required). Can also be the
  `.barnacle/` directory — the skill will resolve `calls.ndjson` inside it.
- `--call-type <name>` (required): one of the stable constants defined in
  `src/lib/telemetry/call-types.ts`:
  - `recon-rephrase` — attempt-4 rephrase inside the recon-browser
    step-healing cascade
  - `recon-replan` — global replan after a step terminally fails
  - `recon-flow-patch` — patch proposal from the recon-flow-patch-generator
    during the recon-heal self-healing loop
  - `llm-prompt-patch` — patch proposal from the llm-call-patch-generator
    during the llm-self-heal loop
  Filters the NDJSON to only lines with this `callType` value.
- `--batch-index <N>` (optional, default 0): disambiguates multiple verdict
  files for the same callType from different runs.
- `--judge-model <model>` (optional): override the Anthropic model used for
  judging. Defaults to the `STAGEHAND_MODEL` environment variable.
- `--out-dir <path>` (optional, default `judge-out`): where to write the
  verdict JSON file.
- `--dry-run` (optional): stubs the scorer with deterministic pass-all values;
  exercises the full pipeline without any API calls (CI mode).

The runner script is `src/scripts/judge-llm-batch.ts`. Invoke it via:
```
pnpm run judge:llm -- --calls-ndjson <path> --call-type <type> [options]
```

The NDJSON line shape (from `src/api/schemas/telemetry.ts`):

```json
{
  "callId": "<UUID v4>",
  "callType": "<str>",
  "model": "<str>",
  "systemPrompt": "<str | null>",
  "userContent": "<str>",
  "responseContent": "<str | null>",
  "parsedOk": true,
  "inputTokens": 0,
  "outputTokens": 0,
  "latencyMs": 0,
  "success": true,
  "ts": "<ISO-8601>"
}
```
</execution_context>

<context>
Barnacle appends every LLM/Stagehand call to `.barnacle/calls.ndjson` via
`src/lib/telemetry/call-capture.ts`. The file is append-only and valid NDJSON
through the last complete line even under a hard kill.

The judge skill operates post-run: it reads the archive, scores a batch, and
writes verdicts. The llm-self-heal skill (`pnpm run heal:llm`) consumes these
verdicts to propose prompt patches.

Each `callType` maps to a LLM call site in Barnacle's source:

| `callType`        | Source file                        | When emitted |
|-------------------|------------------------------------|--------------|
| `recon-rephrase`  | `src/scripts/recon-browser.ts`     | Attempt-4 rephrase inside step-healing cascade |
| `recon-replan`    | `src/scripts/recon-browser.ts`     | Global replan after terminal step failure |
| `recon-flow-patch`| `src/scripts/recon-heal.ts`        | Patch from recon-flow-patch-generator during recon-heal loop |
| `llm-prompt-patch`| `src/scripts/llm-heal.ts`          | Patch from llm-call-patch-generator during llm-self-heal loop |

The `systemPrompt` field in the NDJSON capture is the actual verbatim text
injected — the judge can always derive what the call site was asked to do from
the capture alone. `parsedOk=false` entries automatically fail schema adherence
regardless of what the LLM scorer returns.
</context>

<workflow>

## Step 1: Invoke the judge runner

Run the script via pnpm:

```bash
pnpm run judge:llm -- \
  --calls-ndjson <path-to-calls.ndjson> \
  --call-type <callType> \
  [--batch-index <N>] \
  [--judge-model <model>] \
  [--out-dir <path>] \
  [--dry-run]
```

If zero samples match the requested `callType`, the script exits cleanly with
a log message: `judge-llm-batch: 0 samples for callType="<name>"`. This is
not an error — there may simply be no captures for that call site yet.

## Step 2: Interpret the verdict

Read the written verdict JSON from `judge-out/verdict-<callType>-<batchIndex>.json`.

The aggregate counts (`schemaPass`, `factualPass`, `hallucinationFreePass`,
`overallPass`) relative to `n` give the pass rates per dimension. A low
`schemaPass/n` ratio points to output-format issues; low `factualPass/n`
points to grounding issues; low `hallucinationFreePass/n` points to
fabrication issues.

## Step 3: Emit a summary

```
[<callType>] judged n=<N> schemaPass=<S>/<N> factualPass=<F>/<N> hallucinationFreePass=<H>/<N> overallPass=<P>/<N> → judge-out/verdict-<callType>-<batchIndex>.json
```

If `overallPass < n` (i.e. there are failures), mention that `pnpm run heal:llm`
can be used with this verdict file to start the self-healing loop.

</workflow>

<safety_constraints>
- This skill reads NDJSON captures; it does NOT execute any captured content
- This skill does NOT modify any source files, prompt templates, or live processes
- This skill writes exactly ONE verdict JSON file per invocation to `judge-out/`
- `--dry-run` is safe for CI: it stubs scoring without any API calls
- Do not attempt to "fix" Barnacle's outputs — only judge them
</safety_constraints>

<example_invocations>

Score all `recon-rephrase` samples from the default capture sink:

```bash
pnpm run judge:llm -- \
  --calls-ndjson .barnacle/calls.ndjson \
  --call-type recon-rephrase
```

Score `recon-replan` samples with a specific judge model:

```bash
pnpm run judge:llm -- \
  --calls-ndjson .barnacle/calls.ndjson \
  --call-type recon-replan \
  --judge-model claude-opus-4-8
```

Dry-run in CI (no API calls, all samples pass):

```bash
pnpm run judge:llm -- \
  --calls-ndjson .barnacle/calls.ndjson \
  --call-type recon-flow-patch \
  --dry-run
```

</example_invocations>
