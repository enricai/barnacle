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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { formatISO } from "date-fns";
import {
  type JudgeAggregate,
  type JudgeVerdict,
  type JudgeVerdictEntry,
  judgeVerdictSchema,
  type LlmCallSample,
  llmCallSampleSchema,
} from "@/api/schemas/telemetry";
import { config } from "@/config";
import { JUDGE_VERDICT_SCHEMA } from "@/lib/llm/schemas";
import { getScriptLogger } from "@/lib/logging";

const logger = getScriptLogger("judge-llm-batch");

// ── defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_OUT_DIR = "judge-out";
const DEFAULT_BATCH_INDEX = 0;

// ── types ─────────────────────────────────────────────────────────────────────

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

// ── pure core ─────────────────────────────────────────────────────────────────

/**
 * Reads an NDJSON file and returns the lines parsed as LlmCallSample objects.
 * Lines that fail JSON parsing or Zod validation are returned with
 * parsedOk=false so they auto-fail schema adherence in the judge pass.
 */
export function parseSamples(ndjsonContent: string): LlmCallSample[] {
  const samples: LlmCallSample[] = [];

  for (const raw of ndjsonContent.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      samples.push(makeMalformedSample(line));
      continue;
    }

    const result = llmCallSampleSchema.safeParse(parsed);
    if (!result.success) {
      samples.push(makeMalformedSample(line));
      continue;
    }

    samples.push(result.data);
  }

  return samples;
}

function makeMalformedSample(raw: string): LlmCallSample {
  return {
    callId: `malformed-${raw.slice(0, 16)}`,
    callType: "unknown",
    model: "unknown",
    systemPrompt: null,
    userContent: raw.slice(0, 256),
    responseContent: null,
    parsedOk: false,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
    success: false,
    errorMessage: null,
    failureKind: null,
    ts: formatISO(new Date()),
  };
}

/**
 * Filters samples to only those matching the requested callType.
 */
export function filterByCallType(samples: LlmCallSample[], callType: string): LlmCallSample[] {
  return samples.filter((s) => s.callType === callType);
}

/**
 * Derives a JudgeVerdictEntry from a sample and its score. Enforces the rule
 * that parsedOk=false automatically fails schema adherence regardless of what
 * the scorer returns.
 */
export function computeVerdict(sample: LlmCallSample, score: SampleScore): JudgeVerdictEntry {
  const schemaOk = sample.parsedOk ? score.schemaOk : false;
  const schemaRationale = sample.parsedOk
    ? score.schemaRationale
    : "parsedOk=false: response could not be parsed as the expected schema";

  const pass = schemaOk && score.factuallyGrounded && score.hallucinationFree;

  return {
    callId: sample.callId,
    schemaOk,
    schemaRationale,
    factuallyGrounded: score.factuallyGrounded,
    factualRationale: score.factualRationale,
    hallucinationFree: score.hallucinationFree,
    hallucinationRationale: score.hallucinationRationale,
    ...(score.worstOffender !== undefined ? { worstOffender: score.worstOffender } : {}),
    pass,
  };
}

/**
 * Computes aggregate counts over a set of verdict entries.
 */
export function aggregate(verdicts: JudgeVerdictEntry[]): JudgeAggregate {
  const n = verdicts.length;
  let schemaPass = 0;
  let factualPass = 0;
  let hallucinationFreePass = 0;
  let overallPass = 0;

  for (const v of verdicts) {
    if (v.schemaOk) schemaPass++;
    if (v.factuallyGrounded) factualPass++;
    if (v.hallucinationFree) hallucinationFreePass++;
    if (v.pass) overallPass++;
  }

  return { n, schemaPass, factualPass, hallucinationFreePass, overallPass };
}

/**
 * Validates and writes the verdict object as JSON to the judge-out directory.
 * Returns the written file path.
 */
export function writeVerdict(params: { outDir: string; verdict: JudgeVerdict }): string {
  const { outDir, verdict } = params;

  const parsed = judgeVerdictSchema.safeParse(verdict);
  if (!parsed.success) {
    throw new Error(`verdict does not satisfy judgeVerdictSchema: ${parsed.error.message}`);
  }

  mkdirSync(outDir, { recursive: true });
  const fileName = `verdict-${verdict.callType}-${verdict.batchIndex}.json`;
  const filePath = join(outDir, fileName);
  writeFileSync(filePath, JSON.stringify(verdict, null, 2));
  return filePath;
}

// ── scorer implementations ────────────────────────────────────────────────────

/**
 * Dry-run scorer: marks every dimension true with a placeholder rationale.
 * Used in CI and tests to exercise the full pipeline without any API call.
 */
export function makeDryRunScorer(): ScorerFn {
  return async (): Promise<SampleScore> => ({
    schemaOk: true,
    schemaRationale: "dry-run: schema adherence assumed",
    factuallyGrounded: true,
    factualRationale: "dry-run: factual grounding assumed",
    hallucinationFree: true,
    hallucinationRationale: "dry-run: hallucination-free assumed",
  });
}

function anthropicModelName(): string {
  const raw = config.scraper.model;
  return raw.startsWith("anthropic/") ? raw.slice("anthropic/".length) : raw;
}

const SCORE_SYSTEM_PROMPT = `You are a quality judge for LLM call outputs. Evaluate each sample on three dimensions:

1. SCHEMA_OK: Did the model's response match the expected output structure?
   - true if responseContent is valid JSON that matches the callType's expected schema
   - false if malformed, missing required fields, or has unexpected structure

2. FACTUALLY_GROUNDED: Is the response factually grounded given the input?
   - true if all factual claims in the response are consistent with the userContent context
   - false if the response contradicts or ignores facts present in the userContent

3. HALLUCINATION_FREE: Does the response avoid hallucinating content?
   - true if the response contains no fabricated facts, URLs, entities, or values
   - false if it invents information not implied by the prompt

Set worstOffender to one of "schema", "factual", or "hallucination" naming the worst-failing dimension, or null when all three pass. Each rationale is one short sentence.`;

/**
 * Real LLM scorer: sends each sample to the Anthropic API for judgment.
 * Defaults to the configured scraper model (respects STAGEHAND_MODEL env var)
 * unless overridden by `judgeModel`.
 */
export function makeAnthropicScorer(client: Anthropic, judgeModel?: string): ScorerFn {
  const model = judgeModel ?? anthropicModelName();

  return async (sample: LlmCallSample): Promise<SampleScore> => {
    const userMessage = [
      `callType: ${sample.callType}`,
      `model: ${sample.model}`,
      `parsedOk: ${sample.parsedOk}`,
      `systemPrompt: ${sample.systemPrompt ?? "(none)"}`,
      `userContent: ${sample.userContent}`,
      `responseContent: ${sample.responseContent ?? "(null)"}`,
    ].join("\n");

    try {
      const response = await client.messages.parse({
        model,
        max_tokens: 512,
        system: SCORE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        output_config: {
          format: zodOutputFormat(JUDGE_VERDICT_SCHEMA),
        },
      });
      const parsed = response.parsed_output;
      if (parsed === null) {
        return fallbackScore("structured-output enabled but parsed_output is null");
      }
      return {
        schemaOk: parsed.schemaOk,
        schemaRationale: parsed.schemaRationale,
        factuallyGrounded: parsed.factuallyGrounded,
        factualRationale: parsed.factualRationale,
        hallucinationFree: parsed.hallucinationFree,
        hallucinationRationale: parsed.hallucinationRationale,
        ...(typeof parsed.worstOffender === "string"
          ? { worstOffender: parsed.worstOffender }
          : {}),
      };
    } catch (err) {
      return fallbackScore(
        `API call threw an error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };
}

function fallbackScore(reason: string): SampleScore {
  return {
    schemaOk: false,
    schemaRationale: `judge error: ${reason}`,
    factuallyGrounded: false,
    factualRationale: `judge error: ${reason}`,
    hallucinationFree: false,
    hallucinationRationale: `judge error: ${reason}`,
  };
}

// ── main judge runner ─────────────────────────────────────────────────────────

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
export async function runJudge(params: JudgeParams): Promise<JudgeResult> {
  const {
    callsNdjsonPath,
    callType,
    batchIndex = DEFAULT_BATCH_INDEX,
    judgeModel,
    outDir = DEFAULT_OUT_DIR,
    dryRun = false,
  } = params;

  let scorerFn = params.scorerFn;

  if (!scorerFn) {
    if (dryRun) {
      scorerFn = makeDryRunScorer();
    } else {
      if (!config.scraper.anthropicApiKey) {
        throw new Error("judge:llm requires ANTHROPIC_API_KEY");
      }
      const client = new Anthropic({ apiKey: config.scraper.anthropicApiKey });
      scorerFn = makeAnthropicScorer(client, judgeModel);
    }
  }

  const resolvedJudgeModel = judgeModel ?? (dryRun ? "dry-run" : anthropicModelName());

  logger.info(`judge-llm-batch: reading ${callsNdjsonPath}`);
  let ndjsonContent: string;
  try {
    ndjsonContent = readFileSync(callsNdjsonPath, "utf-8");
  } catch (err) {
    throw new Error(`judge-llm-batch: cannot read ${callsNdjsonPath}: ${String(err)}`);
  }

  const allSamples = parseSamples(ndjsonContent);
  logger.info(`judge-llm-batch: parsed ${allSamples.length} total samples`);

  const samples = filterByCallType(allSamples, callType);
  logger.info(`judge-llm-batch: ${samples.length} samples for callType="${callType}"`);

  const verdicts: JudgeVerdictEntry[] = [];
  for (const sample of samples) {
    logger.info(`judge-llm-batch: scoring callId=${sample.callId}`);
    const score = await scorerFn(sample);
    const entry = computeVerdict(sample, score);
    verdicts.push(entry);
    logger.info(
      `judge-llm-batch: callId=${sample.callId} pass=${entry.pass} schema=${entry.schemaOk} factual=${entry.factuallyGrounded} halluc=${entry.hallucinationFree}`
    );
  }

  const agg = aggregate(verdicts);
  logger.info(
    `judge-llm-batch: aggregate n=${agg.n} schemaPass=${agg.schemaPass} factualPass=${agg.factualPass} hallucinationFreePass=${agg.hallucinationFreePass} overallPass=${agg.overallPass}`
  );

  const verdict: JudgeVerdict = {
    callType,
    batchIndex,
    judgedAt: formatISO(new Date()),
    judgeModel: resolvedJudgeModel,
    verdicts,
    aggregate: agg,
  };

  const verdictPath = writeVerdict({ outDir, verdict });
  logger.info(`judge-llm-batch: verdict written to ${verdictPath}`);

  return { verdictPath, verdict };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

/**
 * Parses CLI args and exits with a usage message when required args are absent.
 */
function parseCli(): JudgeParams {
  const args = process.argv.slice(2);
  let callsNdjsonPath = "";
  let callType = "";
  let batchIndex = DEFAULT_BATCH_INDEX;
  let judgeModel: string | undefined;
  let outDir = DEFAULT_OUT_DIR;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--calls-ndjson" && args[i + 1]) callsNdjsonPath = args[++i]!;
    else if (args[i] === "--call-type" && args[i + 1]) callType = args[++i]!;
    else if (args[i] === "--batch-index" && args[i + 1]) batchIndex = Number(args[++i]);
    else if (args[i] === "--judge-model" && args[i + 1]) judgeModel = args[++i]!;
    else if (args[i] === "--out-dir" && args[i + 1]) outDir = args[++i]!;
    else if (args[i] === "--dry-run") dryRun = true;
  }

  if (!callsNdjsonPath || !callType) {
    logger.error(
      "usage: judge-llm-batch.ts --calls-ndjson <path> --call-type <type> " +
        "[--batch-index N] [--judge-model <model>] [--out-dir <path>] [--dry-run]"
    );
    process.exit(1);
  }

  return { callsNdjsonPath, callType, batchIndex, judgeModel, outDir, dryRun };
}

async function main(): Promise<void> {
  const cliArgs = parseCli();
  const { verdictPath, verdict } = await runJudge(cliArgs);

  logger.info(`judge-llm-batch complete: verdict written to ${verdictPath}`);
  logger.info(
    `judge-llm-batch: n=${verdict.aggregate.n} overallPass=${verdict.aggregate.overallPass}`
  );
}

if (
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("judge-llm-batch.ts") || process.argv[1].endsWith("judge-llm-batch.js"))
) {
  main().catch((err) => {
    logger.error(`judge-llm-batch failed: ${String(err)}`);
    process.exit(1);
  });
}
