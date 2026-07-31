---
name: llm-self-heal
description: "Autonomous self-healing loop for Barnacle LLM prompt templates that produced captured failures. For each callType with failures, runs a measured n=N baseline (unpatched), then iterates: invoke llm-call-patch-generator subagent → apply proposed patch → replay patched arm → score → check convergence (SUCCESS/PLATEAUED/BUDGET_EXHAUSTED/TIMEOUT/REGRESSED). Writes a healing-<callType>.md report per callType with the best patch and the iteration history. Production prompts in src/ stay manual — the skill proposes patches with measured evidence. Runs via `pnpm run heal:llm`."
argument-hint: "--verdict-path <judge-out/verdict-*.json> --call-type <type> [--max-iterations <N>] [--n-replays <N>] [--success-threshold <0..1>] [--out-dir <path>] [--judge-model <model>] [--dry-run]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
---

<objective>
Drive the autonomous heal loop for one Barnacle `callType` that produced
failures in a judge-llm-batch run. The loop iterates:

1. **Baseline** — run n=N unpatched replays per failing sample via the
   Anthropic scorer, establish the noise floor.
2. **Loop** — invoke the `llm-call-patch-generator` subagent to propose a
   minimal patch to the prompt template, apply the patch, replay the patched
   arm via the scorer, check convergence.
3. **Report** — write `<out-dir>/<callType>/healing-<callType>.md` with the
   verdict (SUCCESS / PLATEAUED / BUDGET_EXHAUSTED / REGRESSED), the best
   patch found, and the full iteration history.

**Output:** per `callType` with failures, a heal report and iteration
artifacts under `<out-dir>/<callType>/` (default `llm-heal-out/`).

Production prompt templates in `src/` are NOT modified by this skill.
Patches are proposed evidence — applying them is a separate manual step.
</objective>

<execution_context>
Arguments parsed from `$ARGUMENTS`, forwarded to `pnpm run heal:llm`:
- `--verdict-path <path>` (required): path to a verdict JSON file produced by
  the judge-llm-batch skill (e.g. `judge-out/verdict-recon-rephrase-0.json`).
- `--call-type <name>` (required): one of the stable constants defined in
  `src/lib/telemetry/call-types.ts`:
  - `recon-rephrase` — attempt-4 rephrase inside the recon-browser cascade
  - `recon-replan` — global replan after a terminal step failure
  - `recon-flow-patch` — patch from recon-flow-patch-generator
  - `llm-prompt-patch` — patch from llm-call-patch-generator
- `--max-iterations <N>` (optional, default 5): hard cap on loop iterations.
- `--n-replays <N>` (optional, default 5): replays per arm per failing sample.
- `--success-threshold <0..1>` (optional, default 0.9): pass-rate target for
  SUCCESS exit.
- `--plateau-delta <0..1>` (optional, default 0.03): minimum pass-rate
  improvement to avoid PLATEAUED exit.
- `--plateau-window <N>` (optional, default 3): consecutive iterations with
  small delta → PLATEAUED exit.
- `--out-dir <path>` (optional, default `llm-heal-out`): where to write heal
  state and reports.
- `--judge-model <model>` (optional): override the Anthropic model used for
  scoring replays.
- `--dry-run` (optional): stubs both the scorer and patch generator with
  deterministic values; exercises the loop mechanics without any API calls
  (CI mode).

The runner script is `src/scripts/llm-heal.ts`. Invoke it via:
```
pnpm run heal:llm -- --verdict-path <path> --call-type <type> [options]
```
</execution_context>

<context>
The llm-self-heal skill consumes verdict JSON files written by the
judge-llm-batch skill. It identifies the failing samples (those with
`pass: false` in the verdict), then runs the patch → replay → score cycle
to find a prompt template edit that raises the pass rate above the success
threshold.

### Patch generator

The heal loop spawns the `llm-call-patch-generator` agent
(`.claude/agents/llm-call-patch-generator.md`) per iteration. The agent
receives:
- The current prompt template text
- Up to 3 failing sample examples (userContent + responseContent + rationale)
- The prior iteration history (anchor, replacement, strategy, outcome)

The agent returns `{anchor, replacement, strategy, pivot_reason}`. The caller
verifies that `anchor` is a verbatim substring of the current template before
applying it. If the anchor is not found, the iteration is skipped.

### On-disk state layout

Under `<out-dir>/<callType>/`:

```
state.json               — loop state (history, best-so-far, baseline)
healing-<callType>.md    — final heal report
iter-<N>/
  patch-response.json    — llm-call-patch-generator output
  patched-prompt.txt     — the prompt text after applying the patch
  scores.json            — pass/fail counts for this iteration's arm
```

### callType → source mapping

| `callType`         | Source file                        |
|--------------------|------------------------------------|
| `recon-rephrase`   | `src/scripts/recon-browser.ts`     |
| `recon-replan`     | `src/scripts/recon-browser.ts`     |
| `recon-flow-patch` | `src/scripts/recon-heal.ts`        |
| `llm-prompt-patch` | `src/scripts/llm-heal.ts`          |

Barnacle does not have a `src/prompts/` directory — prompt text is embedded
inline in the call sites above. The heal loop synthesises a representative
base template from the failing samples' judge rationales and the callType
context; the operator inspects the best patch in the heal report and applies
it to the relevant source file manually.
</context>

<workflow>

## Step 1: Pre-flight check

- Confirm `ANTHROPIC_API_KEY` is set in the environment (or `--dry-run` is
  passed). The script exits with an error if the key is absent and dry-run
  is not active.
- Confirm the `--verdict-path` file exists and is valid JSON (the script
  validates it against `judgeVerdictSchema` from
  `src/api/schemas/telemetry.ts`).
- If the verdict has zero failing samples, the script exits immediately with
  `SUCCESS` — nothing to heal.

## Step 2: Invoke the heal runner

```bash
pnpm run heal:llm -- \
  --verdict-path <path> \
  --call-type <callType> \
  [--max-iterations <N>] \
  [--n-replays <N>] \
  [--success-threshold <0..1>] \
  [--out-dir <path>] \
  [--judge-model <model>] \
  [--dry-run]
```

The runner handles all iteration logic internally. Progress is logged via
pino to stdout. The heal report is written when the loop exits.

## Step 3: Read the heal report

After the runner exits, read
`<out-dir>/<callType>/healing-<callType>.md` to review:
- The convergence verdict and reason
- The best patch found (anchor + replacement + strategy)
- The iteration history table (pass rate delta per iteration)

## Step 4: Advise on next steps

Present the best patch to the user with the measured pass rate improvement.
Remind the user that production source files are NOT modified — they must
apply the patch manually to the relevant call site after review.

If the verdict is PLATEAUED or BUDGET_EXHAUSTED with a best pass rate below
the threshold, suggest increasing `--max-iterations` or `--n-replays` for a
deeper search, or inspecting the individual iteration artifacts under
`<out-dir>/<callType>/iter-<N>/`.

</workflow>

<safety_constraints>
- This skill reads verdict JSON and NDJSON capture files
- This skill writes only into `<out-dir>/<callType>/` — never into `src/`
- This skill does NOT modify any source files or prompt templates
- Patches are proposed with measured evidence — applying them requires a
  separate manual step by the operator
- Replays make real Anthropic API calls using `ANTHROPIC_API_KEY`; warn the
  user if the estimated call count is large (failures × n_replays × max_iterations)
  before proceeding
- `--dry-run` is safe for CI: stubs all API calls
</safety_constraints>

<example_invocations>

Heal the `recon-rephrase` callType using the default verdict from the judge:

```bash
pnpm run heal:llm -- \
  --verdict-path judge-out/verdict-recon-rephrase-0.json \
  --call-type recon-rephrase
```

Heal with tighter budget (3 iterations, 3 replays):

```bash
pnpm run heal:llm -- \
  --verdict-path judge-out/verdict-recon-replan-0.json \
  --call-type recon-replan \
  --max-iterations 3 \
  --n-replays 3 \
  --success-threshold 0.85
```

Dry-run in CI (no API calls, loop runs to BUDGET_EXHAUSTED mechanically):

```bash
pnpm run heal:llm -- \
  --verdict-path judge-out/verdict-recon-flow-patch-0.json \
  --call-type recon-flow-patch \
  --dry-run
```

</example_invocations>
