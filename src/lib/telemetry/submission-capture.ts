/**
 * Append-only NDJSON sink for submission envelopes, from `dispatch()` and from
 * extra routes that declare `submits`. One line per plugin invocation captures
 * the outcome — siteId, requestId, an allowlisted
 * summary of the request body (only the keys the plugin declares persistable),
 * status, audit payload, error message, duration, plus the opaque `joinKeys`
 * bag and the `kind:"submit"` dimension — so downstream tooling (ETL, jq,
 * ad-hoc queries) can answer "what did we submit for jobId X on date Y, and
 * did it succeed?" without a database, and a plugin can join runs to its own
 * attribution provider's report without re-parsing `inboundPayload`.
 *
 * Kept on a separate sink from calls.ndjson because the judge and self-heal
 * readers Zod-parse every calls.ndjson line as an LlmCallSample; mixing record
 * shapes would force a discriminator + filter on every consumer.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { formatISO } from "date-fns";
import type { z } from "zod/v4";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { redactionPolicyFor, redactPiiDeep } from "@/lib/pii-redaction";
import { submitRecordSchema } from "@/lib/telemetry/reconciliation-record";
import { bufferSubmissionLine } from "@/lib/telemetry/s3-sink";
import type { InboundPayloadSummary } from "@/types/pii-redaction";

const logger = getLogger({ name: "telemetry/submission-capture" });

/**
 * Validated shape of one submission envelope sample. Alias of
 * `submitRecordSchema` (feat-002) kept under its original export name so the
 * five existing test files that import it are unaffected — the reconciliation
 * schema is a strict superset (adds `kind`, `joinKeys`, `session`) of the
 * shape this module used to define standalone.
 */
export const submissionEnvelopeSampleSchema = submitRecordSchema;

export type SubmissionEnvelopeSample = z.infer<typeof submissionEnvelopeSampleSchema>;

/**
 * Input to `captureSubmissionEnvelope` — `ts` and `kind` are derived
 * internally so callers omit them.
 */
export type SubmissionEnvelopeInput = Omit<SubmissionEnvelopeSample, "ts" | "kind">;

/**
 * Reduces a request body to what telemetry consumers read, because the raw
 * body can carry personal data and the sink lands in long-retention S3
 * storage. Only the plugin's declared `persistKeys` keep their values; every
 * other key is recorded by name in `fieldsPresent`. Non-object bodies
 * collapse to `null`.
 */
export function summarizeInboundPayload(
  payload: unknown,
  persistKeys: readonly string[] = []
): InboundPayloadSummary | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const summary: InboundPayloadSummary = { fieldsPresent: [] };
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") continue;
    if (persistKeys.includes(key) && (typeof value === "string" || typeof value === "number")) {
      summary[key] = value;
      continue;
    }
    summary.fieldsPresent.push(key);
  }
  summary.fieldsPresent.sort();
  return summary;
}

/** Options for `captureSubmissionEnvelope`. */
export interface CaptureSubmissionOptions {
  /** Override the sink path; used in tests to avoid touching the real file. */
  sinkPath?: string;
}

/**
 * Ensures the sink directory exists, appends `line`, and forwards it to the
 * S3 buffer. Extracted so the beacon-event writer can share the exact
 * mkdir/append/buffer sequence instead of re-implementing it (CLAUDE.md
 * §DRY) — callers own their own error handling since the swallow-all
 * contract differs per writer.
 */
export async function appendSubmissionSinkLine(sinkPath: string, line: string): Promise<void> {
  await mkdir(dirname(sinkPath), { recursive: true });
  await appendFile(sinkPath, line, "utf8");
  bufferSubmissionLine(line);
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
  if (config.telemetry.enabled === false) return;
  const sinkPath = opts.sinkPath ?? config.telemetry.submissionsNdjsonPath;
  const sample = redactPiiDeep({
    ...input,
    inboundPayload: summarizeInboundPayload(
      input.inboundPayload,
      redactionPolicyFor(input.siteId)?.persistKeys
    ),
    kind: "submit",
    ts: formatISO(new Date()),
  }) as SubmissionEnvelopeSample;

  try {
    const line = `${JSON.stringify(sample)}\n`;
    await appendSubmissionSinkLine(sinkPath, line);
  } catch (err) {
    logger.error(`captureSubmissionEnvelope: failed to write to ${sinkPath}: ${String(err)}`);
  }
}
