/**
 * Recon self-heal harness: given a site whose recon flow produced terminal
 * step failures, iterate — baseline-replay the flow, ask the
 * recon-flow-patch-generator to propose a minimal patch to one step,
 * replay the patched flow, score, check convergence. Writes a
 * healing-<siteId>.md report so the human can review and manually apply
 * the best patch. The source recon-flow.json is NEVER modified.
 *
 * Usage:
 *   pnpm tsx src/scripts/recon-heal.ts \
 *     --site-id my-site \
 *     --url https://my-site.example.com
 *
 * Knobs (all optional):
 *   --max-iterations <N>        default 5
 *   --n-replays <N>             default 3 (Steel sessions are expensive)
 *   --success-threshold <0..1>  default 0.9
 *   --plateau-delta <0..1>      default 0.03
 *   --plateau-window <N>        default 3
 *   --out-dir <path>            default heal-out
 *   --dry-run                   stubs the browser runner (CI mode)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import { formatISO } from "date-fns";

import { config } from "@/config";
import { configureHttpDispatcher } from "@/lib/http";
import { getScriptLogger } from "@/lib/logging";
import { StepVerificationError } from "@/scraper/errors";
import { createBrowserSession } from "@/scraper/session";

configureHttpDispatcher();

const logger = getScriptLogger("recon-heal");

// ── defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_N_REPLAYS = 3;
const DEFAULT_SUCCESS_THRESHOLD = 0.9;
const DEFAULT_PLATEAU_DELTA = 0.03;
const DEFAULT_PLATEAU_WINDOW = 3;
const DEFAULT_OUT_DIR = "heal-out";

/** Warn before starting when estimated Steel+Anthropic calls exceed this. */
const COST_WARNING_THRESHOLD = 30;

// ── types ─────────────────────────────────────────────────────────────────────

/**
 * Patch proposed by the recon-flow-patch-generator. `anchor` is a verbatim
 * substring of the failing step; `replacement` is the new step text to
 * substitute in place of `anchor`.
 */
export interface FlowPatch {
  anchor: string;
  replacement: string;
  strategy: string;
  pivot_reason: string | null;
}

/** Convergence verdicts emitted at the end of the loop. */
export type HealVerdict = "SUCCESS" | "PLATEAUED" | "BUDGET_EXHAUSTED" | "REGRESSED";

/** One row in the per-iteration history. */
export interface IterationRecord {
  iterN: number;
  passRate: number;
  patch: FlowPatch | null;
}

/** Persistent state written to state.json after each iteration. */
export interface HealState {
  siteId: string;
  originalFlow: string[];
  baselinePassRate: number;
  history: IterationRecord[];
  bestPassRate: number;
  bestPatch: FlowPatch | null;
  bestIterN: number;
}

/** Result returned from a single flow replay. */
export interface ReplayResult {
  passRate: number;
  passCount: number;
  failCount: number;
}

/** Injectable step runner — real or dry-run stub. */
export type StepRunner = (params: {
  flow: string[];
  url: string;
  runId: string;
}) => Promise<ReplayResult>;

// ── Anthropic client ──────────────────────────────────────────────────────────

/**
 * Returns the Anthropic client, or null when the deployment is Bedrock-only.
 * The heal loop requires the Anthropic SDK (not Bedrock) because it calls
 * claude.ai claude-code-agent-style subagent behaviour inline.
 */
export function buildAnthropicClient(): Anthropic | null {
  if (config.scraper.useBedrock || !config.scraper.anthropicApiKey) return null;
  return new Anthropic({ apiKey: config.scraper.anthropicApiKey });
}

function anthropicModelName(): string {
  const raw = config.scraper.model;
  return raw.startsWith("anthropic/") ? raw.slice("anthropic/".length) : raw;
}

// ── patch generator ───────────────────────────────────────────────────────────

/**
 * Asks the model to propose a minimal patch to one failing step, following
 * the recon-flow-patch-generator subagent discipline: anchor is a verbatim
 * substring, replacement is the new step text.
 */
export async function requestPatch(params: {
  client: Anthropic;
  currentFlow: string[];
  failingSteps: string[];
  iterN: number;
  priorAttempts: Array<{
    iter: number;
    anchor: string;
    replacement: string;
    strategy: string;
    outcome: "improved" | "no_change" | "regressed";
  }>;
}): Promise<FlowPatch | null> {
  const { client, currentFlow, failingSteps, iterN, priorAttempts } = params;

  const flowJson = JSON.stringify(currentFlow, null, 2);
  const failingList = failingSteps.map((s, i) => `  ${i + 1}. "${s}"`).join("\n");
  const historySection =
    priorAttempts.length > 0
      ? priorAttempts
          .map(
            (a) =>
              `  iter ${a.iter}: anchor="${a.anchor}" replacement="${a.replacement}" strategy="${a.strategy}" outcome=${a.outcome}`
          )
          .join("\n")
      : "  (no prior attempts)";

  const prompt = `You are the recon-flow-patch-generator for barnacle. Propose a minimal patch to fix a failing step in a recon flow. This is iteration ${iterN}.

## CURRENT FLOW JSON
${flowJson}

## FAILING STEPS (steps that terminally failed browser automation)
${failingList}

## PRIOR ITERATION HISTORY
${historySection}

## YOUR TASK
Propose a patch to exactly ONE failing step. Apply the minimise-change principle:
- anchor must be a verbatim substring of one of the step strings in the CURRENT FLOW JSON above — copy-paste it exactly
- replacement is the new text to substitute in place of anchor
- Prefer clarifying ambiguous phrasing over rewriting a clear instruction
- Add visible landmarks (labels, headings) to reduce selector ambiguity
- Do not anchor on text that appears in multiple steps
- Do not repeat a strategy already in PRIOR ITERATION HISTORY
- If PRIOR ITERATION HISTORY shows no_change or regressed, pivot to a fundamentally different approach and explain in pivot_reason

Return ONLY a single JSON object — no prose, no markdown, no code fences:
{
  "anchor": "<exact verbatim substring of one step in current flow>",
  "replacement": "<new natural-language step text to substitute for anchor>",
  "strategy": "<one sentence describing what this patch does and why>",
  "pivot_reason": <null on first iteration, otherwise a string explaining the pivot>
}`;

  try {
    const response = await client.messages.create({
      model: anthropicModelName(),
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return null;

    const text = block.text.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).anchor !== "string" ||
      typeof (parsed as Record<string, unknown>).replacement !== "string" ||
      typeof (parsed as Record<string, unknown>).strategy !== "string"
    ) {
      return null;
    }

    const raw = parsed as Record<string, unknown>;
    const patch: FlowPatch = {
      anchor: raw.anchor as string,
      replacement: raw.replacement as string,
      strategy: raw.strategy as string,
      pivot_reason: typeof raw.pivot_reason === "string" ? raw.pivot_reason : null,
    };

    // Verify the anchor appears verbatim in at least one step.
    const anchorFound = currentFlow.some((step) => step.includes(patch.anchor));
    if (!anchorFound) {
      logger.warn(`patch anchor not found in current flow: "${patch.anchor}"`);
      return null;
    }

    return patch;
  } catch {
    return null;
  }
}

// ── patch application ─────────────────────────────────────────────────────────

/**
 * Applies a patch by replacing the first occurrence of `anchor` in the step
 * that contains it. Returns a new flow array; the original is never mutated.
 */
export function applyPatch(flow: string[], patch: FlowPatch): string[] {
  const patched = flow.map((step) => {
    if (step.includes(patch.anchor)) {
      return step.replace(patch.anchor, patch.replacement);
    }
    return step;
  });
  return patched;
}

// ── convergence ───────────────────────────────────────────────────────────────

/**
 * Determines the convergence verdict given the current history and thresholds.
 * Checks in order: SUCCESS → REGRESSED → BUDGET_EXHAUSTED → PLATEAUED → CONTINUE.
 */
export function checkConvergence(params: {
  history: IterationRecord[];
  bestPassRate: number;
  maxIterations: number;
  successThreshold: number;
  plateauDelta: number;
  plateauWindow: number;
}): HealVerdict | "CONTINUE" {
  const { history, bestPassRate, maxIterations, successThreshold, plateauDelta, plateauWindow } =
    params;

  if (history.length === 0) return "CONTINUE";

  const latest = history[history.length - 1]!;

  // SUCCESS: the latest pass rate cleared the threshold.
  if (latest.passRate >= successThreshold) return "SUCCESS";

  // BUDGET_EXHAUSTED: ran out of iterations.
  if (history.length >= maxIterations) return "BUDGET_EXHAUSTED";

  // REGRESSED: last plateau_window iters have all dropped > plateau_delta below best.
  if (history.length >= plateauWindow) {
    const window = history.slice(-plateauWindow);
    const allRegressed = window.every((h) => bestPassRate - h.passRate > plateauDelta);
    if (allRegressed) return "REGRESSED";
  }

  // PLATEAUED: last plateau_window iters are all within plateau_delta of each other.
  if (history.length >= plateauWindow) {
    const window = history.slice(-plateauWindow);
    const rates = window.map((h) => h.passRate);
    const min = Math.min(...rates);
    const max = Math.max(...rates);
    if (max - min < plateauDelta) return "PLATEAUED";
  }

  return "CONTINUE";
}

// ── step runner ───────────────────────────────────────────────────────────────

/**
 * Dry-run step runner: all steps pass immediately. Used in CI to avoid real
 * Steel sessions. Accepts a dry-run pass rate override for testing convergence.
 */
export function makeDryRunStepRunner(passRate: number = 1.0): StepRunner {
  return async ({
    flow,
  }: {
    flow: string[];
    url: string;
    runId: string;
  }): Promise<ReplayResult> => {
    const total = flow.length;
    const passCount = Math.round(total * passRate);
    const failCount = total - passCount;
    return { passRate: total > 0 ? passCount / total : 0, passCount, failCount };
  };
}

/**
 * Real step runner: drives recon-browser.ts against a live Steel session.
 * Each step that throws StepVerificationError counts as a failure.
 */
export function makeRealStepRunner(): StepRunner {
  return async ({
    flow,
    url,
  }: {
    flow: string[];
    url: string;
    runId: string;
  }): Promise<ReplayResult> => {
    let passCount = 0;
    let failCount = 0;

    const session = await createBrowserSession();
    try {
      const page = await session.stagehand.context.awaitActivePage();
      await page.goto(url, { waitUntil: "domcontentloaded" });

      for (const step of flow) {
        try {
          const result = await session.stagehand.act(step);
          if (!result.success) {
            failCount++;
          } else {
            passCount++;
          }
        } catch (err) {
          if (err instanceof StepVerificationError) {
            failCount++;
          } else {
            failCount++;
          }
        }
      }
    } finally {
      await session.close().catch(() => undefined);
    }

    const total = flow.length;
    return {
      passRate: total > 0 ? passCount / total : 0,
      passCount,
      failCount,
    };
  };
}

// ── state persistence ─────────────────────────────────────────────────────────

/**
 * Writes the current heal state to heal-out/<siteId>/state.json so the
 * operator can inspect progress and the loop can resume across interruptions.
 */
export function writeState(outDir: string, siteId: string, state: HealState): void {
  const dir = join(outDir, siteId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

/**
 * Writes the per-iteration artifacts under heal-out/<siteId>/iter-N/.
 */
export function writeIterationArtifacts(params: {
  outDir: string;
  siteId: string;
  iterN: number;
  patchRequest: {
    currentFlow: string[];
    failingSteps: string[];
    iterN: number;
    priorAttempts: unknown[];
  };
  patch: FlowPatch | null;
  appliedFlow: string[];
  passRate: number;
  passCount: number;
  failCount: number;
}): void {
  const {
    outDir,
    siteId,
    iterN,
    patchRequest,
    patch,
    appliedFlow,
    passRate,
    passCount,
    failCount,
  } = params;
  const dir = join(outDir, siteId, `iter-${iterN}`);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, "patch-request.json"), JSON.stringify(patchRequest, null, 2));
  writeFileSync(join(dir, "patch-response.json"), JSON.stringify(patch, null, 2));
  writeFileSync(join(dir, "applied-flow.json"), JSON.stringify(appliedFlow, null, 2));
  writeFileSync(
    join(dir, "arm-results.json"),
    JSON.stringify({ iterN, passCount, failCount }, null, 2)
  );
  writeFileSync(
    join(dir, "scores.json"),
    JSON.stringify({ iterN, passRate, passCount, failCount }, null, 2)
  );
}

// ── report ────────────────────────────────────────────────────────────────────

/**
 * Writes the healing report markdown and returns its path.
 */
export function writeHealReport(params: {
  outDir: string;
  siteId: string;
  state: HealState;
  verdict: HealVerdict;
}): string {
  const { outDir, siteId, state, verdict } = params;
  const dir = join(outDir, siteId);
  mkdirSync(dir, { recursive: true });

  const historyRows = [
    `| iter | pass_rate | delta |`,
    `|------|-----------|-------|`,
    `| 0 (baseline) | ${(state.baselinePassRate * 100).toFixed(0)}% | — |`,
    ...state.history.map((h, idx) => {
      const prev = idx === 0 ? state.baselinePassRate : state.history[idx - 1]!.passRate;
      const delta = h.passRate - prev;
      const deltaStr = `${(delta >= 0 ? "+" : "") + (delta * 100).toFixed(0)}%`;
      return `| ${h.iterN} | ${(h.passRate * 100).toFixed(0)}% | ${deltaStr} |`;
    }),
  ].join("\n");

  const bestPatchBlock =
    state.bestPatch !== null
      ? [
          `**Anchor:**`,
          `\`\`\``,
          state.bestPatch.anchor,
          `\`\`\``,
          ``,
          `**Replacement:**`,
          `\`\`\``,
          state.bestPatch.replacement,
          `\`\`\``,
          ``,
          `**Strategy:** ${state.bestPatch.strategy}`,
        ].join("\n")
      : "(no patch improved the baseline)";

  const report = [
    `# Heal report: ${siteId}`,
    ``,
    `**Verdict:** ${verdict}`,
    `**Iterations run:** ${state.history.length}`,
    `**Baseline pass rate:** ${(state.baselinePassRate * 100).toFixed(0)}%`,
    `**Best pass rate:** ${(state.bestPassRate * 100).toFixed(0)}% (iter ${state.bestIterN})`,
    ``,
    `## Best patch`,
    ``,
    bestPatchBlock,
    ``,
    `## Iteration history`,
    ``,
    historyRows,
    ``,
    `---`,
    `_Generated by recon-heal at ${formatISO(new Date())}_`,
    `_Production recon-flow.json was NOT modified. Apply the patch above manually after review._`,
  ].join("\n");

  const reportPath = join(dir, `healing-${siteId}.md`);
  writeFileSync(reportPath, report);
  return reportPath;
}

// ── main heal loop ────────────────────────────────────────────────────────────

export interface HealParams {
  siteId: string;
  url: string;
  maxIterations?: number;
  nReplays?: number;
  successThreshold?: number;
  plateauDelta?: number;
  plateauWindow?: number;
  outDir?: string;
  dryRun?: boolean;
  stepRunner?: StepRunner;
  requestPatchFn?: typeof requestPatch;
}

export interface HealResult {
  verdict: HealVerdict;
  reportPath: string;
  state: HealState;
}

/**
 * Drives the full baseline → patch → replay → converge loop for a single site.
 * Accepts injectable `stepRunner` and `requestPatchFn` so tests can stub the
 * expensive browser and LLM operations.
 */
export async function phaseHeal(params: HealParams): Promise<HealResult> {
  const {
    siteId,
    url,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    nReplays = DEFAULT_N_REPLAYS,
    successThreshold = DEFAULT_SUCCESS_THRESHOLD,
    plateauDelta = DEFAULT_PLATEAU_DELTA,
    plateauWindow = DEFAULT_PLATEAU_WINDOW,
    outDir = DEFAULT_OUT_DIR,
    dryRun = false,
  } = params;

  const stepRunner = params.stepRunner ?? (dryRun ? makeDryRunStepRunner() : makeRealStepRunner());
  const requestPatchFn = params.requestPatchFn ?? requestPatch;

  // ── pre-flight ──────────────────────────────────────────────────────────────

  const flowFilePath = resolve(join("src", "sites", siteId, "recon-flow.json"));
  const originalFlow: string[] = JSON.parse(readFileSync(flowFilePath, "utf-8")) as string[];

  logger.info(`recon-heal: site=${siteId} flow_steps=${originalFlow.length} url=${url}`);

  const estimatedCalls = (1 + maxIterations) * nReplays * 2;
  if (estimatedCalls > COST_WARNING_THRESHOLD) {
    logger.warn(
      `recon-heal: estimated ${estimatedCalls} calls (threshold=${COST_WARNING_THRESHOLD}). ` +
        `Reduce --max-iterations or --n-replays to lower cost.`
    );
  }

  const anthropic = dryRun ? null : buildAnthropicClient();
  if (!dryRun && !anthropic) {
    throw new Error(
      "recon-heal requires ANTHROPIC_API_KEY — Bedrock-only deployments are not supported"
    );
  }

  mkdirSync(join(outDir, siteId), { recursive: true });

  // ── baseline ────────────────────────────────────────────────────────────────

  logger.info(`recon-heal: baseline (n_replays=${nReplays})`);

  let baselinePassSum = 0;
  for (let r = 0; r < nReplays; r++) {
    const runId = `heal-baseline-${siteId}-r${r}`;
    const result = await stepRunner({ flow: originalFlow, url, runId });
    baselinePassSum += result.passRate;
    logger.info(`recon-heal: baseline r${r} pass_rate=${(result.passRate * 100).toFixed(0)}%`);
  }
  const baselinePassRate = nReplays > 0 ? baselinePassSum / nReplays : 0;
  logger.info(`recon-heal: baseline avg pass_rate=${(baselinePassRate * 100).toFixed(0)}%`);

  const state: HealState = {
    siteId,
    originalFlow,
    baselinePassRate,
    history: [],
    bestPassRate: baselinePassRate,
    bestPatch: null,
    bestIterN: 0,
  };
  writeState(outDir, siteId, state);

  if (baselinePassRate >= successThreshold) {
    logger.info("recon-heal: baseline already meets threshold — exiting SUCCESS");
    const reportPath = writeHealReport({ outDir, siteId, state, verdict: "SUCCESS" });
    return { verdict: "SUCCESS", reportPath, state };
  }

  // ── iteration loop ──────────────────────────────────────────────────────────

  let currentFlow = [...originalFlow];
  // Failing steps: steps not passing at baseline (simple heuristic — all steps contribute)
  let failingSteps = [...originalFlow];
  const priorAttempts: Array<{
    iter: number;
    anchor: string;
    replacement: string;
    strategy: string;
    outcome: "improved" | "no_change" | "regressed";
  }> = [];

  let convergeResult: HealVerdict | "CONTINUE" = "CONTINUE";

  while (convergeResult === "CONTINUE") {
    const iterN = state.history.length + 1;
    logger.info(`recon-heal: iteration ${iterN}/${maxIterations}`);

    const patchRequest = {
      currentFlow,
      failingSteps,
      iterN,
      priorAttempts: [...priorAttempts],
    };

    let patch: FlowPatch | null = null;
    if (anthropic) {
      patch = await requestPatchFn({
        client: anthropic,
        currentFlow,
        failingSteps,
        iterN,
        priorAttempts,
      });
    }

    if (!patch) {
      logger.warn(`recon-heal: iter ${iterN} — patch-generator returned null, stopping`);
      convergeResult = "BUDGET_EXHAUSTED";
      break;
    }

    const appliedFlow = applyPatch(currentFlow, patch);

    // Replay patched arm n_replays times, average the pass rate.
    let patchedPassSum = 0;
    let totalPassCount = 0;
    let totalFailCount = 0;
    for (let r = 0; r < nReplays; r++) {
      const runId = `heal-iter${iterN}-${siteId}-r${r}`;
      const result = await stepRunner({ flow: appliedFlow, url, runId });
      patchedPassSum += result.passRate;
      totalPassCount += result.passCount;
      totalFailCount += result.failCount;
      logger.info(
        `recon-heal: iter ${iterN} r${r} pass_rate=${(result.passRate * 100).toFixed(0)}%`
      );
    }
    const passRate = nReplays > 0 ? patchedPassSum / nReplays : 0;

    const prevBest = state.bestPassRate;
    const record: IterationRecord = { iterN, passRate, patch };
    state.history.push(record);

    if (passRate > state.bestPassRate) {
      state.bestPassRate = passRate;
      state.bestPatch = patch;
      state.bestIterN = iterN;
      currentFlow = appliedFlow;
      // Update failing steps: these are the steps in the current best flow.
      failingSteps = appliedFlow;
    }

    const outcome: "improved" | "no_change" | "regressed" =
      passRate > prevBest + plateauDelta
        ? "improved"
        : passRate < prevBest - plateauDelta
          ? "regressed"
          : "no_change";

    priorAttempts.push({
      iter: iterN,
      anchor: patch.anchor,
      replacement: patch.replacement,
      strategy: patch.strategy,
      outcome,
    });

    writeIterationArtifacts({
      outDir,
      siteId,
      iterN,
      patchRequest,
      patch,
      appliedFlow,
      passRate,
      passCount: totalPassCount,
      failCount: totalFailCount,
    });

    writeState(outDir, siteId, state);

    logger.info(
      `recon-heal: iter ${iterN} pass_rate=${(passRate * 100).toFixed(0)}% ` +
        `best=${(state.bestPassRate * 100).toFixed(0)}% outcome=${outcome}`
    );

    convergeResult = checkConvergence({
      history: state.history,
      bestPassRate: state.bestPassRate,
      maxIterations,
      successThreshold,
      plateauDelta,
      plateauWindow,
    });
  }

  const finalVerdict = convergeResult as HealVerdict;
  const reportPath = writeHealReport({ outDir, siteId, state, verdict: finalVerdict });
  logger.info(`recon-heal: verdict=${finalVerdict} report=${reportPath}`);

  return { verdict: finalVerdict, reportPath, state };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

/**
 * Parses CLI args and exits with a usage message when required args are absent.
 */
function parseCli(): HealParams {
  const args = process.argv.slice(2);
  let siteId = "";
  let url = "";
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let nReplays = DEFAULT_N_REPLAYS;
  let successThreshold = DEFAULT_SUCCESS_THRESHOLD;
  let plateauDelta = DEFAULT_PLATEAU_DELTA;
  let plateauWindow = DEFAULT_PLATEAU_WINDOW;
  let outDir = DEFAULT_OUT_DIR;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--site-id" && args[i + 1]) siteId = args[++i]!;
    else if (args[i] === "--url" && args[i + 1]) url = args[++i]!;
    else if (args[i] === "--max-iterations" && args[i + 1]) maxIterations = Number(args[++i]);
    else if (args[i] === "--n-replays" && args[i + 1]) nReplays = Number(args[++i]);
    else if (args[i] === "--success-threshold" && args[i + 1]) successThreshold = Number(args[++i]);
    else if (args[i] === "--plateau-delta" && args[i + 1]) plateauDelta = Number(args[++i]);
    else if (args[i] === "--plateau-window" && args[i + 1]) plateauWindow = Number(args[++i]);
    else if (args[i] === "--out-dir" && args[i + 1]) outDir = args[++i]!;
    else if (args[i] === "--dry-run") dryRun = true;
  }

  if (!siteId || !url) {
    logger.error(
      "usage: recon-heal.ts --site-id <id> --url <url> [--max-iterations N] [--n-replays N] " +
        "[--success-threshold 0..1] [--plateau-delta 0..1] [--plateau-window N] " +
        "[--out-dir <path>] [--dry-run]"
    );
    process.exit(1);
  }

  return {
    siteId,
    url,
    maxIterations,
    nReplays,
    successThreshold,
    plateauDelta,
    plateauWindow,
    outDir,
    dryRun,
  };
}

async function main(): Promise<void> {
  const cliArgs = parseCli();
  const { verdict, reportPath, state } = await phaseHeal(cliArgs);

  logger.info(`recon-heal complete: verdict=${verdict}`);
  logger.info(`recon-heal: best_pass_rate=${(state.bestPassRate * 100).toFixed(0)}%`);
  logger.info(`recon-heal: report written to ${reportPath}`);
}

if (
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("recon-heal.ts") || process.argv[1].endsWith("recon-heal.js"))
) {
  main().catch((err) => {
    logger.error(`recon-heal failed: ${String(err)}`);
    process.exit(1);
  });
}
