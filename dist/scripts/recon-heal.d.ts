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
import Anthropic from "@anthropic-ai/sdk";
import { type LlmCallInput } from "../lib/telemetry/call-capture";
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
/** Injectable capture function — matches `captureLlmCall`'s signature. */
export type CaptureFn = (input: LlmCallInput) => Promise<void>;
/**
 * Returns the Anthropic client, or null when the deployment is Bedrock-only.
 * The heal loop requires the Anthropic SDK (not Bedrock) because it calls
 * claude.ai claude-code-agent-style subagent behaviour inline.
 */
export declare function buildAnthropicClient(): Anthropic | null;
/**
 * Asks the model to propose a minimal patch to one failing step, following
 * the recon-flow-patch-generator subagent discipline: anchor is a verbatim
 * substring, replacement is the new step text.
 */
export declare function requestPatch(params: {
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
    captureFn?: CaptureFn;
}): Promise<FlowPatch | null>;
/**
 * Produces a patched flow without touching the source — callers depend on the
 * original remaining unmodified so it can be safely re-used across iterations.
 */
export declare function applyPatch(flow: string[], patch: FlowPatch): string[];
/**
 * Determines the convergence verdict given the current history and thresholds.
 * Checks in order: SUCCESS → REGRESSED → BUDGET_EXHAUSTED → PLATEAUED → CONTINUE.
 */
export declare function checkConvergence(params: {
    history: IterationRecord[];
    bestPassRate: number;
    maxIterations: number;
    successThreshold: number;
    plateauDelta: number;
    plateauWindow: number;
}): HealVerdict | "CONTINUE";
/**
 * Dry-run step runner: all steps pass immediately. Used in CI to avoid real
 * Steel sessions. Accepts a dry-run pass rate override for testing convergence.
 */
export declare function makeDryRunStepRunner(passRate?: number): StepRunner;
/**
 * Real step runner: drives recon-browser.ts against a live Steel session.
 * Each step that throws StepVerificationError counts as a failure.
 */
export declare function makeRealStepRunner(): StepRunner;
/**
 * Writes the current heal state to heal-out/<siteId>/state.json so the
 * operator can inspect progress and the loop can resume across interruptions.
 */
export declare function writeState(outDir: string, siteId: string, state: HealState): void;
/**
 * Persists all per-iteration inputs and outputs so the operator can audit
 * exactly what the patch-generator saw and how the patched arm performed.
 */
export declare function writeIterationArtifacts(params: {
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
}): void;
/**
 * Writes the healing report markdown and returns its path.
 */
export declare function writeHealReport(params: {
    outDir: string;
    siteId: string;
    state: HealState;
    verdict: HealVerdict;
}): string;
/** Parameters accepted by `phaseHeal` — all fields except `siteId` and `url` are optional with sensible defaults. */
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
/** Return value of `phaseHeal` — verdict, written report path, and final in-memory state. */
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
export declare function phaseHeal(params: HealParams): Promise<HealResult>;
