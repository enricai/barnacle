/**
 * Structured metrics payload attached to dispatch responses so the caller can
 * forward step-level detail into Segment events for A/B warehouse analysis.
 */

import { z } from "zod/v4";

export interface DispatchStepMetric {
  step: string;
  durationMs: number;
  status: "success" | "failed" | "skipped";
  error?: string;
}

export interface DispatchMetrics {
  totalDurationMs: number;
  path: "http" | "browser";
  steps: DispatchStepMetric[];
  errorType?: string;
  errorStep?: string;
  attemptCount: number;
  startedAt: string;
  endedAt: string;
  recordedAt: string;
}

export const DispatchMetricsSchema = z.object({
  totalDurationMs: z.number(),
  path: z.enum(["http", "browser"]),
  steps: z.array(
    z.object({
      step: z.string(),
      durationMs: z.number(),
      status: z.enum(["success", "failed", "skipped"]),
      error: z.string().optional(),
    })
  ),
  errorType: z.string().optional(),
  errorStep: z.string().optional(),
  attemptCount: z.number(),
  startedAt: z.string(),
  endedAt: z.string(),
  recordedAt: z.string(),
});
