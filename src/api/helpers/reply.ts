import type { FastifyReply } from "fastify";

import { buildErrorEnvelope, httpStatusForCode } from "@/api/errors";
import type { ErrorCode } from "@/api/schemas/common";
import { redactPii, redactPiiDeep } from "@/lib/pii-redaction";
import type { DispatchMetrics } from "@/types/dispatch-metrics";

/**
 * Sends a standard error envelope on the given reply, optionally including
 * dispatch metrics so the caller can forward step-level detail even on failures.
 */
export function replyWithError(
  reply: FastifyReply,
  code: ErrorCode,
  message: string,
  detailType?: string,
  statusOverride?: number,
  metrics?: DispatchMetrics
): void {
  // Error messages and per-step metrics embed step instructions, which carry
  // applicant values; scrub them before they leave the process.
  const envelope = buildErrorEnvelope(code, redactPii(message), detailType);
  const body = metrics ? { ...envelope, metrics: redactPiiDeep(metrics) } : envelope;
  void reply.status(statusOverride ?? httpStatusForCode(code)).send(body);
}
