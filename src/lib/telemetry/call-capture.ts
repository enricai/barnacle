/**
 * Append-only NDJSON sink for LLM/Stagehand call samples. Each call emits
 * exactly one line so the judge and self-heal skills have a scoreable corpus
 * without coupling this module to any specific call site.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { formatISO } from "date-fns";
import { z } from "zod/v4";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { bufferCallLine } from "@/lib/telemetry/s3-sink";

const logger = getLogger({ name: "telemetry/call-capture" });

/**
 * Categorical failure reason for an LLM call. Surfaces post-mortem without
 * regex-scanning `errorMessage`. Discriminated upstream by the caller.
 */
export const llmCallFailureKindSchema = z.enum([
  "anthropic-billing",
  "anthropic-rate-limit",
  "anthropic-other",
  "schema-validation-failed",
  "response-empty",
  "exception-other",
]);
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
export const ANTHROPIC_QUOTA_MESSAGE_RX =
  /(your credit balance is too low|insufficient_quota|billing_hard_limit_reached|reached your specified API usage limits|usage limits)/i;

/**
 * Extract the HTTP status from any of: direct `.status`, `.statusCode`,
 * or the `"<NNN> {json}"` prefix the Vercel ai SDK uses for its default
 * error message format. Returns undefined when no status signal exists.
 */
function extractAnthropicStatus(
  errorObj: Record<string, unknown> | null,
  message: string
): number | undefined {
  if (errorObj !== null) {
    if (typeof errorObj.status === "number") return errorObj.status;
    if (typeof errorObj.statusCode === "number") return errorObj.statusCode;
  }
  const match = message.match(/(?:^|\s)(\d{3})\s+\{/);
  if (match?.[1]) {
    const parsed = Number.parseInt(match[1], 10);
    if (parsed >= 100 && parsed < 600) return parsed;
  }
  return undefined;
}

/**
 * Extract Anthropic's structured `error.type` from whichever shape the SDK
 * chain exposed: direct `.type` (Anthropic SDK APIError), `.responseBody`
 * JSON (Vercel ai SDK APICallError), `.data` (Vercel ai SDK), or the JSON
 * body embedded in `err.message` as `"<status> {json}"` (the Vercel ai
 * SDK's default toString format). Returns null when no structured marker
 * is present.
 */
function extractAnthropicErrorType(errorObj: Record<string, unknown> | null): string | null {
  if (errorObj === null) return null;
  if (typeof errorObj.type === "string") return errorObj.type;
  const responseBody = errorObj.responseBody;
  if (typeof responseBody === "string" && responseBody.length > 0) {
    try {
      const parsed = JSON.parse(responseBody) as { error?: { type?: unknown }; type?: unknown };
      const t = parsed.error?.type ?? parsed.type;
      if (typeof t === "string") return t;
    } catch {
      // fall through
    }
  }
  const data = errorObj.data as { error?: { type?: unknown }; type?: unknown } | undefined;
  if (data !== undefined && data !== null) {
    const t = data.error?.type ?? data.type;
    if (typeof t === "string") return t;
  }
  const message = typeof errorObj.message === "string" ? errorObj.message : "";
  const jsonMatch = message.match(/\d{3}\s+(\{.+\})$/s);
  if (jsonMatch?.[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as { error?: { type?: unknown }; type?: unknown };
      const t = parsed.error?.type ?? parsed.type;
      if (typeof t === "string") return t;
    } catch {
      // fall through
    }
  }
  return null;
}

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
export function classifyLlmCallFailure(err: unknown): LlmCallFailureKind {
  const errorObj =
    typeof err === "object" && err !== null ? (err as Record<string, unknown>) : null;
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const structuredType = extractAnthropicErrorType(errorObj);
  const status = extractAnthropicStatus(errorObj, message);
  if (structuredType === "billing_error" || status === 402) return "anthropic-billing";
  if (structuredType === "rate_limit_error" || status === 429 || name === "RateLimitError") {
    return "anthropic-rate-limit";
  }
  if (status === 400 && structuredType === "invalid_request_error") {
    if (ANTHROPIC_QUOTA_MESSAGE_RX.test(message)) return "anthropic-billing";
    return "anthropic-other";
  }
  if (structuredType !== null) return "anthropic-other";
  if (typeof status === "number" && status >= 400 && status < 600) return "anthropic-other";
  if (ANTHROPIC_QUOTA_MESSAGE_RX.test(message)) return "anthropic-billing";
  if (/APIError$|AnthropicError$|APICallError$/.test(name)) return "anthropic-other";
  if (/zod|schema|parsed_output is null/i.test(message)) return "schema-validation-failed";
  return "exception-other";
}

/**
 * Validated shape of one LLM call sample. Field names follow beacon/pila's
 * NDJSON contract but in Barnacle's camelCase convention.
 */
export const llmCallSampleSchema = z.object({
  callId: z.string(),
  callType: z.string(),
  model: z.string(),
  systemPrompt: z.string().nullable(),
  userContent: z.string(),
  responseContent: z.string().nullable(),
  parsedOk: z.boolean(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  latencyMs: z.number().nullable(),
  success: z.boolean(),
  errorMessage: z.string().nullable(),
  failureKind: llmCallFailureKindSchema.nullable(),
  ts: z.string(),
});

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
export async function captureLlmCall(
  input: LlmCallInput,
  opts: CaptureOptions = {}
): Promise<void> {
  const sinkPath = opts.sinkPath ?? config.telemetry.callsNdjsonPath;
  const sample: LlmCallSample = { ...input, ts: formatISO(new Date()) };

  try {
    const line = `${JSON.stringify(sample)}\n`;
    await mkdir(dirname(sinkPath), { recursive: true });
    await appendFile(sinkPath, line, "utf8");
    bufferCallLine(line);
  } catch (err) {
    logger.error(`captureLlmCall: failed to write to ${sinkPath}: ${String(err)}`);
  }
}
