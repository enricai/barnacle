/**
 * Append-only NDJSON sink for dispatch submission envelopes. One line per
 * plugin invocation captures the outcome — siteId, requestId, inbound payload,
 * status, audit payload, error message, duration — so downstream tooling (ETL,
 * jq, ad-hoc queries) can answer "what did we submit for jobId X on date Y,
 * and did it succeed?" without a database.
 *
 * Kept on a separate sink from calls.ndjson because the judge and self-heal
 * readers Zod-parse every calls.ndjson line as an LlmCallSample; mixing record
 * shapes would force a discriminator + filter on every consumer.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { formatISO } from "date-fns";
import { z } from "zod/v4";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { bufferSubmissionLine } from "@/lib/telemetry/s3-sink";

const logger = getLogger({ name: "telemetry/submission-capture" });

/**
 * Validated shape of one submission envelope sample. Carries the dispatch
 * outcome (siteId, status, audit payload, error message, duration) plus the
 * inbound request body and requestId needed to correlate with upstream traces.
 */
export const submissionEnvelopeSampleSchema = z.object({
  siteId: z.string(),
  requestId: z.string(),
  inboundPayload: z.unknown(),
  status: z.enum(["submitted", "error"]),
  auditPayload: z.unknown(),
  errorMessage: z.string().nullable(),
  durationMs: z.number(),
  ts: z.string(),
});

export type SubmissionEnvelopeSample = z.infer<typeof submissionEnvelopeSampleSchema>;

/** Input to `captureSubmissionEnvelope` — `ts` is derived internally so callers omit it. */
export type SubmissionEnvelopeInput = Omit<SubmissionEnvelopeSample, "ts">;

/** Options for `captureSubmissionEnvelope`. */
export interface CaptureSubmissionOptions {
  /** Override the sink path; used in tests to avoid touching the real file. */
  sinkPath?: string;
}

/**
 * Appends one validated NDJSON line for a dispatch outcome to the configured
 * sink. Errors are logged and swallowed — telemetry must never break the
 * happy path, matching the contract `captureLlmCall` enforces for LLM samples.
 */
export async function captureSubmissionEnvelope(
  input: SubmissionEnvelopeInput,
  opts: CaptureSubmissionOptions = {}
): Promise<void> {
  const sinkPath = opts.sinkPath ?? config.telemetry.submissionsNdjsonPath;
  const sample: SubmissionEnvelopeSample = { ...input, ts: formatISO(new Date()) };

  try {
    const line = `${JSON.stringify(sample)}\n`;
    await mkdir(dirname(sinkPath), { recursive: true });
    await appendFile(sinkPath, line, "utf8");
    bufferSubmissionLine(line);
  } catch (err) {
    logger.error(`captureSubmissionEnvelope: failed to write to ${sinkPath}: ${String(err)}`);
  }
}
