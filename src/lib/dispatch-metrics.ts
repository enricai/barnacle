/**
 * Lightweight step-timing accumulator for a single dispatch invocation.
 * Instantiated per-request in the dispatch layer, threaded through
 * SitePluginContext, and finalized into a DispatchMetrics payload that
 * ships in the response body for caller → Segment forwarding.
 */
import { formatISO } from "date-fns";

import type { DispatchMetrics, DispatchStepMetric } from "@/types/dispatch-metrics";

/** Accumulates step-level timing for a single dispatch, producing a DispatchMetrics payload for the response. */
export class MetricsCollector {
  private steps: DispatchStepMetric[] = [];
  private currentStep: string | undefined;
  private stepStart = 0;
  private attempts = 1;
  private started: number;

  constructor() {
    this.started = Date.now();
  }

  /** Marks the beginning of a named step. Ends any in-progress step as failed. */
  startStep(name: string): void {
    if (this.currentStep) {
      this.endStep("failed", "interrupted by next step");
    }
    this.currentStep = name;
    this.stepStart = Date.now();
  }

  /** Marks the current step as complete with the given status. */
  endStep(status: "success" | "failed" | "skipped", error?: string): void {
    if (!this.currentStep) return;
    this.steps.push({
      step: this.currentStep,
      durationMs: Date.now() - this.stepStart,
      status,
      ...(error && { error }),
    });
    this.currentStep = undefined;
  }

  /** Increments the attempt counter on retry. Keeps all recorded steps. */
  markRetry(): void {
    this.attempts++;
  }

  /** Produces the final DispatchMetrics payload. Safe to call multiple times. */
  finalize(path: "http" | "browser"): DispatchMetrics {
    if (this.currentStep) {
      this.endStep("failed", "dispatch ended before step completed");
    }
    const failedStep = this.steps.find((s) => s.status === "failed");
    return {
      totalDurationMs: Date.now() - this.started,
      path,
      steps: this.steps,
      ...(failedStep?.error && { errorType: failedStep.error }),
      ...(failedStep && { errorStep: failedStep.step }),
      attemptCount: this.attempts,
      startedAt: formatISO(new Date(this.started)),
      endedAt: formatISO(new Date()),
      recordedAt: formatISO(new Date()),
    };
  }
}
