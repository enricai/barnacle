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
 * Recognises the message shapes Anthropic returns when an account hits its
 * credit / quota / hard-limit ceiling. Exported so callers that need to
 * react to billing exhaustion (e.g. recon-browser's per-process FATAL
 * banner) share one source of truth with the failure-kind classifier.
 */
export const ANTHROPIC_BILLING_RX =
  /(your credit balance is too low|insufficient_quota|billing_hard_limit_reached)/i;

/**
 * Classify a thrown error from an LLM call into one of the discrete failure
 * kinds. Keeps the call-capture module SDK-agnostic: probes `err.status` and
 * `err.name` instead of `instanceof Anthropic.*Error`, so the helper works
 * for any provider whose SDK errors expose those standard HTTP fields.
 */
export function classifyLlmCallFailure(err: unknown): LlmCallFailureKind {
  const message = err instanceof Error ? err.message : String(err);
  if (ANTHROPIC_BILLING_RX.test(message)) return "anthropic-billing";
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? (err as { status: unknown }).status
      : undefined;
  const name = err instanceof Error ? err.name : "";
  if (status === 429 || name === "RateLimitError") return "anthropic-rate-limit";
  if (typeof status === "number" && status >= 400 && status < 600) return "anthropic-other";
  if (/APIError$|AnthropicError$/.test(name)) return "anthropic-other";
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
  } catch (err) {
    logger.error(`captureLlmCall: failed to write to ${sinkPath}: ${String(err)}`);
  }
}
