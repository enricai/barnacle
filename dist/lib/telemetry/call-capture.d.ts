/**
 * Append-only NDJSON sink for LLM/Stagehand call samples. Each call emits
 * exactly one line so the judge and self-heal skills have a scoreable corpus
 * without coupling this module to any specific call site.
 */
import { z } from "zod/v4";
/**
 * Categorical failure reason for an LLM call. Surfaces post-mortem without
 * regex-scanning `errorMessage`. Discriminated upstream by the caller.
 */
export declare const llmCallFailureKindSchema: z.ZodEnum<{
    "anthropic-billing": "anthropic-billing";
    "anthropic-rate-limit": "anthropic-rate-limit";
    "anthropic-other": "anthropic-other";
    "schema-validation-failed": "schema-validation-failed";
    "response-empty": "response-empty";
    "exception-other": "exception-other";
}>;
export type LlmCallFailureKind = z.infer<typeof llmCallFailureKindSchema>;
/**
 * Anthropic returns status 400 + `error.type === "invalid_request_error"`
 * for BOTH genuine bad-request errors AND quota/spend-limit exhaustion.
 * The official taxonomy at https://platform.claude.com/docs/en/api/errors
 * reuses the same enum value for format problems and quota hits; only the
 * embedded `error.message` text discriminates the latter. This regex is
 * confined to that single ambiguous status+type branch in
 * classifyLlmCallFailure — it is not a broad message scan.
 */
export declare const ANTHROPIC_QUOTA_MESSAGE_RX: RegExp;
/**
 * Classify a thrown LLM-call error into one of the discrete failure kinds.
 *
 * Strategy (priority-ordered):
 *   1. Status + structured `error.type` from the SDK fields. Anthropic's
 *      documented taxonomy: 402 + billing_error = payment; 429 +
 *      rate_limit_error = rate-limited.
 *   2. For the (400 + invalid_request_error) tuple, Anthropic provides no
 *      structural discriminator between "bad format" and "quota exhausted"
 *      — match the embedded error.message against ANTHROPIC_QUOTA_MESSAGE_RX
 *      to identify the latter. This is the one documented exception to
 *      structural classification.
 *   3. Best-effort fallbacks for errors whose SDK shape stripped structure
 *      (legacy paths, generic exceptions).
 *
 * SDK-agnostic via duck-typing — works with @anthropic-ai/sdk's APIError,
 * Vercel ai SDK's APICallError, or any provider exposing similar fields.
 */
export declare function classifyLlmCallFailure(err: unknown): LlmCallFailureKind;
/**
 * Validated shape of one LLM call sample. Field names follow beacon/pila's
 * NDJSON contract but in Barnacle's camelCase convention.
 */
export declare const llmCallSampleSchema: z.ZodObject<{
    callId: z.ZodString;
    callType: z.ZodString;
    model: z.ZodString;
    systemPrompt: z.ZodNullable<z.ZodString>;
    userContent: z.ZodString;
    responseContent: z.ZodNullable<z.ZodString>;
    parsedOk: z.ZodBoolean;
    inputTokens: z.ZodNullable<z.ZodNumber>;
    outputTokens: z.ZodNullable<z.ZodNumber>;
    latencyMs: z.ZodNullable<z.ZodNumber>;
    success: z.ZodBoolean;
    errorMessage: z.ZodNullable<z.ZodString>;
    failureKind: z.ZodNullable<z.ZodEnum<{
        "anthropic-billing": "anthropic-billing";
        "anthropic-rate-limit": "anthropic-rate-limit";
        "anthropic-other": "anthropic-other";
        "schema-validation-failed": "schema-validation-failed";
        "response-empty": "response-empty";
        "exception-other": "exception-other";
    }>>;
    ts: z.ZodString;
}, z.core.$strip>;
export type LlmCallSample = z.infer<typeof llmCallSampleSchema>;
/** Input to `captureLlmCall` — `ts` is derived internally so callers omit it. */
export type LlmCallInput = Omit<LlmCallSample, "ts">;
/** Options for `captureLlmCall`. */
export interface CaptureOptions {
    /** Override the sink path; used in tests to avoid touching the real file. */
    sinkPath?: string;
}
/**
 * Appends one validated NDJSON line for an LLM call to the configured sink.
 * Errors are logged and swallowed — telemetry must never break the happy path.
 */
export declare function captureLlmCall(input: LlmCallInput, opts?: CaptureOptions): Promise<void>;
