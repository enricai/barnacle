/**
 * Structured metrics payload attached to dispatch responses so Vivian can
 * forward step-level detail into Segment events for A/B warehouse analysis.
 */

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
