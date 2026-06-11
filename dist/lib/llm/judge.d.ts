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
import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod/v4";
import { type LlmCallInput } from "../../lib/telemetry/call-capture";
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
export declare function callHaikuJudge<T extends z.ZodTypeAny>(params: HaikuJudgeParams<T>): Promise<HaikuJudgeResult<T> | null>;
