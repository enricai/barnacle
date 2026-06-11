/**
 * LLM batch judge: reads a calls.ndjson capture file, filters by callType,
 * scores each sample on a three-dimensional rubric (schema adherence, factual
 * grounding, hallucination-freeness), aggregates the results, and writes a
 * schema-valid verdict JSON to the judge-out directory.
 *
 * Usage:
 *   pnpm judge:llm \
 *     --calls-ndjson .barnacle/calls.ndjson \
 *     --call-type act \
 *     --batch-index 0 \
 *     --judge-model claude-sonnet-4-6
 *
 * Knobs (all optional):
 *   --out-dir <path>        default judge-out
 *   --dry-run               stubs the scorer (CI mode, no API calls)
 *   --batch-index <N>       default 0; disambiguates multiple verdict files
 */
import Anthropic from "@anthropic-ai/sdk";
import { type JudgeAggregate, type JudgeVerdict, type JudgeVerdictEntry, type LlmCallSample } from "../api/schemas/telemetry";
/** Raw scoring dimensions returned by the scorer for a single sample. */
export interface SampleScore {
    schemaOk: boolean;
    schemaRationale: string;
    factuallyGrounded: boolean;
    factualRationale: string;
    hallucinationFree: boolean;
    hallucinationRationale: string;
    worstOffender?: string;
}
/**
 * Injectable scorer — real implementation calls the LLM; dry-run stub
 * returns deterministic values. Mirrors recon-heal's requestPatchFn injection
 * so the deterministic core (parse/aggregate/write) is fully unit-testable.
 */
export type ScorerFn = (sample: LlmCallSample) => Promise<SampleScore>;
/**
 * Reads an NDJSON file and returns the lines parsed as LlmCallSample objects.
 * Lines that fail JSON parsing or Zod validation are returned with
 * parsedOk=false so they auto-fail schema adherence in the judge pass.
 */
export declare function parseSamples(ndjsonContent: string): LlmCallSample[];
/**
 * Filters samples to only those matching the requested callType.
 */
export declare function filterByCallType(samples: LlmCallSample[], callType: string): LlmCallSample[];
/**
 * Derives a JudgeVerdictEntry from a sample and its score. Enforces the rule
 * that parsedOk=false automatically fails schema adherence regardless of what
 * the scorer returns.
 */
export declare function computeVerdict(sample: LlmCallSample, score: SampleScore): JudgeVerdictEntry;
/**
 * Computes aggregate counts over a set of verdict entries.
 */
export declare function aggregate(verdicts: JudgeVerdictEntry[]): JudgeAggregate;
/**
 * Validates and writes the verdict object as JSON to the judge-out directory.
 * Returns the written file path.
 */
export declare function writeVerdict(params: {
    outDir: string;
    verdict: JudgeVerdict;
}): string;
/**
 * Dry-run scorer: marks every dimension true with a placeholder rationale.
 * Used in CI and tests to exercise the full pipeline without any API call.
 */
export declare function makeDryRunScorer(): ScorerFn;
/**
 * Real LLM scorer: sends each sample to the Anthropic API for judgment.
 * Defaults to the configured scraper model (respects STAGEHAND_MODEL env var)
 * unless overridden by `judgeModel`.
 */
export declare function makeAnthropicScorer(client: Anthropic, judgeModel?: string): ScorerFn;
/** Parameters accepted by `runJudge`. */
export interface JudgeParams {
    callsNdjsonPath: string;
    callType: string;
    batchIndex?: number;
    judgeModel?: string;
    outDir?: string;
    dryRun?: boolean;
    /** Injectable scorer for unit tests. */
    scorerFn?: ScorerFn;
}
/** Return value of `runJudge`. */
export interface JudgeResult {
    verdictPath: string;
    verdict: JudgeVerdict;
}
/**
 * Drives the full parse → filter → score → aggregate → write pipeline for a
 * single batch. Accepts an injectable `scorerFn` so tests exercise the full
 * pipeline without any live model call.
 */
export declare function runJudge(params: JudgeParams): Promise<JudgeResult>;
