/**
 * Generic Haiku 4.5 judge primitive. Every fuzzy-data judgment in the engine
 * routes through this — submit-verification, invalid-field detection, modal-
 * priority ranking, error-message extraction. Replaces deterministic regexes
 * that silently miss patterns outside what we've happened to observe across
 * AppCast + ClearCompany (both Angular).
 *
 * Why a separate primitive instead of inlining into each call site:
 *  - Single chokepoint for telemetry, error classification, and latency
 *    accounting across all judge calls.
 *  - Pinned model + always-on structured output prevents drift: every
 *    call site uses `messages.parse` + `output_config.format` so Haiku's
 *    GA constrained-decoding makes schema violations structurally
 *    impossible.
 *  - Soft cost-control: clamps `max_tokens` to a small default since
 *    verdicts are small JSON blobs, not prose.
 *
 * Model selection: Haiku 4.5 is GA, costs $1 / $5 per million tokens
 * (input/output), runs in ~810ms p50 TTFT on Anthropic's first-party API,
 * and has its own rate-limit pool separate from Opus. Validated empirically
 * 2026-06-11 on two production failure dumps — see plan file for the
 * verifySubmit cases.
 *
 * On schema/API failure the wrapper returns null and logs the failureKind
 * via classifyLlmCallFailure(); callers are expected to fall back to a
 * conservative default (typically "not verified" / "no judgment").
 */

import { randomUUID } from "node:crypto";

import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod/v4";

import { getScriptLogger } from "@/lib/logging";
import {
  captureLlmCall,
  classifyLlmCallFailure,
  type LlmCallInput,
} from "@/lib/telemetry/call-capture";

const logger = getScriptLogger("haiku-judge");

/**
 * Pinned Haiku version. We pin to a dated snapshot so prompts that
 * empirically work today keep working when Anthropic ships a newer
 * Haiku — model behavior on edge cases can shift between minor versions.
 */
const HAIKU_MODEL_ID = "claude-haiku-4-5-20251001";

/** Default max-tokens for verdict outputs. Verdicts are small JSON blobs;
 * 512 tokens comfortably covers any of our schemas including the rationale
 * fields, while preventing accidental cost explosion if the LLM tried to
 * write prose. */
const DEFAULT_MAX_TOKENS = 512;

/** Warn threshold for input prompt size. Haiku TTFT degrades with context;
 * the cutoff below isn't a hard ceiling, just a sanity bell for prompts
 * that would benefit from trimming before they ship to production. */
const LARGE_PROMPT_WARN_CHARS = 32_000;

/** Injectable capture function — matches `captureLlmCall`'s signature. */
export type JudgeCaptureFn = (input: LlmCallInput) => Promise<void>;

export interface HaikuJudgeParams<T extends z.ZodTypeAny> {
  client: Anthropic;
  systemPrompt: string;
  userPrompt: string;
  schema: T;
  callType: string;
  maxTokens?: number;
  captureFn?: JudgeCaptureFn;
}

export interface HaikuJudgeResult<T extends z.ZodTypeAny> {
  parsed: z.infer<T>;
  latencyMs: number;
}

/**
 * Send a structured-output judgment request to Haiku 4.5. Returns the
 * parsed verdict and the wall-clock latency. Returns null on any failure
 * (API error, schema-validation error, parsed_output null) — callers fall
 * back to a conservative default.
 *
 * The telemetry contract matches every other engine LLM call site exactly:
 * one NDJSON entry per call regardless of outcome, with parsedOk/success
 * fields distinguishing happy path from failure modes.
 */
export async function callHaikuJudge<T extends z.ZodTypeAny>(
  params: HaikuJudgeParams<T>
): Promise<HaikuJudgeResult<T> | null> {
  const {
    client,
    systemPrompt,
    userPrompt,
    schema,
    callType,
    maxTokens = DEFAULT_MAX_TOKENS,
    captureFn = captureLlmCall,
  } = params;

  if (userPrompt.length > LARGE_PROMPT_WARN_CHARS) {
    logger.warn(
      `haiku-judge ${callType}: large prompt ${userPrompt.length} chars; consider trimming for latency`
    );
  }

  const callId = randomUUID();
  const t0 = performance.now();
  try {
    const response = await client.messages.parse({
      model: HAIKU_MODEL_ID,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      output_config: {
        format: zodOutputFormat(schema),
      },
    });
    const latencyMs = performance.now() - t0;
    const parsed = response.parsed_output;
    if (parsed === null) {
      throw new Error("structured-output enabled but parsed_output is null");
    }
    const textBlock = response.content.find((b) => b.type === "text");
    const rawText = textBlock?.type === "text" ? textBlock.text : "";

    await captureFn({
      callId,
      callType,
      model: HAIKU_MODEL_ID,
      systemPrompt,
      userContent: userPrompt,
      responseContent: rawText,
      parsedOk: true,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      latencyMs,
      success: true,
      errorMessage: null,
      failureKind: null,
    });

    return { parsed: parsed as z.infer<T>, latencyMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const latencyMs = performance.now() - t0;
    await captureFn({
      callId,
      callType,
      model: HAIKU_MODEL_ID,
      systemPrompt,
      userContent: userPrompt,
      responseContent: null,
      parsedOk: false,
      inputTokens: null,
      outputTokens: null,
      latencyMs,
      success: false,
      errorMessage: message,
      failureKind: classifyLlmCallFailure(err),
    });
    return null;
  }
}
