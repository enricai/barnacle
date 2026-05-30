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

  let line: string;
  try {
    line = `${JSON.stringify(sample)}\n`;
  } catch (err) {
    logger.error(`captureLlmCall: failed to serialize sample: ${String(err)}`);
    return;
  }

  try {
    await mkdir(dirname(sinkPath), { recursive: true });
    await appendFile(sinkPath, line, "utf8");
  } catch (err) {
    logger.error(`captureLlmCall: failed to write to ${sinkPath}: ${String(err)}`);
  }
}
