/**
 * LLM prompt-template self-heal harness: given a judge verdict file containing
 * failing samples for a callType, iterate — run a baseline pass rate, ask the
 * patch generator to propose a minimal edit to the prompt template, replay the
 * patched prompt against the captured user_content, score, and check convergence.
 * Writes a healing-<callType>.md report for human review and manual apply.
 * Production prompts in src/prompts/ are NEVER modified.
 *
 * Usage:
 *   pnpm heal:llm \
 *     --verdict-path judge-out/verdict-act-0.json \
 *     --call-type act
 *
 * Knobs (all optional):
 *   --max-iterations <N>        default 5
 *   --n-replays <N>             default 5
 *   --success-threshold <0..1>  default 0.9
 *   --plateau-delta <0..1>      default 0.03
 *   --plateau-window <N>        default 3
 *   --out-dir <path>            default llm-heal-out
 *   --judge-model <model>       override the judge model
 *   --dry-run                   stubs the scorer (CI mode, no API calls)
 */
import Anthropic from "@anthropic-ai/sdk";
import { type LlmCallSample } from "../api/schemas/telemetry";
import { type LlmCallInput } from "../lib/telemetry/call-capture";
import { type ScorerFn } from "../scripts/judge-llm-batch";
import { type FlowPatch, type HealVerdict, type IterationRecord } from "../scripts/recon-heal";
/**
 * Persistent state written after each iteration so the operator can inspect
 * progress. Mirrors recon-heal's HealState but scoped to prompt-template arms.
 */
export interface LlmHealState {
    callType: string;
    baselinePassRate: number;
    history: IterationRecord[];
    bestPassRate: number;
    bestPatch: FlowPatch | null;
    bestIterN: number;
}
/** Injectable replay runner — real or dry-run stub. */
export type ReplayFn = (params: {
    samples: LlmCallSample[];
    promptTemplate: string;
    scorerFn: ScorerFn;
    nReplays: number;
}) => Promise<{
    passRate: number;
    passCount: number;
    failCount: number;
}>;
/** Injectable patch-request function for unit tests. */
export type RequestPromptPatchFn = (params: {
    client: Anthropic;
    callType: string;
    promptTemplate: string;
    failingSamples: LlmCallSample[];
    iterN: number;
    priorAttempts: Array<{
        iter: number;
        anchor: string;
        replacement: string;
        strategy: string;
        outcome: "improved" | "no_change" | "regressed";
    }>;
    captureFn?: (input: LlmCallInput) => Promise<void>;
}) => Promise<FlowPatch | null>;
/** Parameters accepted by `phaseLlmHeal`. */
export interface LlmHealParams {
    verdictPath: string;
    callType: string;
    maxIterations?: number;
    nReplays?: number;
    successThreshold?: number;
    plateauDelta?: number;
    plateauWindow?: number;
    outDir?: string;
    judgeModel?: string;
    dryRun?: boolean;
    replayFn?: ReplayFn;
    requestPatchFn?: RequestPromptPatchFn;
    scorerFn?: ScorerFn;
}
/** Return value of `phaseLlmHeal`. */
export interface LlmHealResult {
    verdict: HealVerdict;
    reportPath: string;
    state: LlmHealState;
}
/**
 * Returns the Anthropic client, or null when the deployment is Bedrock-only.
 */
export declare function buildAnthropicClient(): Anthropic | null;
/**
 * Asks the model to propose a minimal patch to the prompt template, following
 * the same anchor/replacement discipline as recon-flow-patch-generator but
 * applied to a natural-language system or user prompt string.
 */
export declare function requestPromptPatch(params: {
    client: Anthropic;
    callType: string;
    promptTemplate: string;
    failingSamples: LlmCallSample[];
    iterN: number;
    priorAttempts: Array<{
        iter: number;
        anchor: string;
        replacement: string;
        strategy: string;
        outcome: "improved" | "no_change" | "regressed";
    }>;
    captureFn?: (input: LlmCallInput) => Promise<void>;
}): Promise<FlowPatch | null>;
/**
 * Scores each failing sample with the given scorer, treating the patched
 * prompt as the system prompt context. Repeats nReplays times per sample and
 * averages the pass rate — accounts for LLM non-determinism on borderline cases.
 */
export declare function replayPromptArm(params: {
    samples: LlmCallSample[];
    promptTemplate: string;
    scorerFn: ScorerFn;
    nReplays: number;
}): Promise<{
    passRate: number;
    passCount: number;
    failCount: number;
}>;
/**
 * Dry-run replay runner: marks every sample as passing without calling the
 * scorer. Used in CI to verify the loop mechanics without any API calls.
 */
export declare function makeDryRunReplayFn(passRate?: number): ReplayFn;
/**
 * Writes the current heal state to llm-heal-out/<callType>/state.json so the
 * operator can inspect progress across interruptions.
 */
export declare function writeLlmHealState(outDir: string, callType: string, state: LlmHealState): void;
/**
 * Persists per-iteration inputs and outputs for audit.
 */
export declare function writeLlmIterationArtifacts(params: {
    outDir: string;
    callType: string;
    iterN: number;
    patch: FlowPatch | null;
    patchedPrompt: string;
    passRate: number;
    passCount: number;
    failCount: number;
}): void;
/**
 * Writes the healing report markdown and returns its path.
 */
export declare function writeLlmHealReport(params: {
    outDir: string;
    callType: string;
    state: LlmHealState;
    verdict: HealVerdict;
}): string;
/**
 * Drives the full baseline → patch → replay → converge loop for a single
 * callType's failing prompt. Accepts injectable `replayFn`, `requestPatchFn`,
 * and `scorerFn` so tests can stub LLM calls and scoring.
 */
export declare function phaseLlmHeal(params: LlmHealParams): Promise<LlmHealResult>;
