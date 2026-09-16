import { describe, expect, it } from "vitest";

import { MetricsCollector } from "@/lib/dispatch-metrics";

describe("lib/dispatch-metrics MetricsCollector", () => {
  it("records duration and status for a successful step", () => {
    const collector = new MetricsCollector();
    collector.startStep("fetch");
    collector.endStep("success");
    const metrics = collector.finalize("http");
    expect(metrics.steps).toHaveLength(1);
    expect(metrics.steps[0]?.step).toBe("fetch");
    expect(metrics.steps[0]?.status).toBe("success");
    expect(metrics.steps[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.steps[0]?.error).toBeUndefined();
  });

  it("auto-ends an in-progress step as failed('interrupted by next step') when a new step starts", () => {
    const collector = new MetricsCollector();
    collector.startStep("first");
    collector.startStep("second");
    collector.endStep("success");
    const metrics = collector.finalize("http");
    expect(metrics.steps).toHaveLength(2);
    expect(metrics.steps[0]?.step).toBe("first");
    expect(metrics.steps[0]?.status).toBe("failed");
    expect(metrics.steps[0]?.error).toBe("interrupted by next step");
    expect(metrics.steps[1]?.step).toBe("second");
    expect(metrics.steps[1]?.status).toBe("success");
  });

  it("increments attemptCount in finalize() on each markRetry call", () => {
    const collector = new MetricsCollector();
    collector.markRetry();
    collector.markRetry();
    const metrics = collector.finalize("browser");
    expect(metrics.attemptCount).toBe(3);
  });

  it("surfaces errorType/errorStep from the failed step when one exists", () => {
    const collector = new MetricsCollector();
    collector.startStep("submit");
    collector.endStep("failed", "network timeout");
    const metrics = collector.finalize("http");
    expect(metrics.errorType).toBe("network timeout");
    expect(metrics.errorStep).toBe("submit");
  });

  it("omits errorType/errorStep when no step failed", () => {
    const collector = new MetricsCollector();
    collector.startStep("submit");
    collector.endStep("success");
    const metrics = collector.finalize("http");
    expect(metrics.errorType).toBeUndefined();
    expect(metrics.errorStep).toBeUndefined();
  });

  it("auto-ends a still-open step as failed('dispatch ended before step completed') on finalize", () => {
    const collector = new MetricsCollector();
    collector.startStep("hanging");
    const metrics = collector.finalize("http");
    expect(metrics.steps).toHaveLength(1);
    expect(metrics.steps[0]?.status).toBe("failed");
    expect(metrics.steps[0]?.error).toBe("dispatch ended before step completed");
    expect(metrics.errorType).toBe("dispatch ended before step completed");
    expect(metrics.errorStep).toBe("hanging");
  });

  it("is safe to call finalize() twice, preserving steps and attemptCount", () => {
    const collector = new MetricsCollector();
    collector.startStep("only");
    collector.endStep("success");
    collector.markRetry();
    const first = collector.finalize("http");
    const second = collector.finalize("http");
    expect(second.steps).toHaveLength(1);
    expect(second.attemptCount).toBe(2);
    expect(second.attemptCount).toBe(first.attemptCount);
  });
});
