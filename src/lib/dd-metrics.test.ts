import { beforeEach, describe, expect, it, vi } from "vitest";

const { statsdStub } = vi.hoisted(() => ({
  statsdStub: {
    increment: vi.fn(),
    timing: vi.fn(),
    close: vi.fn(),
  },
}));
vi.mock("@/lib/statsd", () => ({ getStatsD: () => statsdStub }));

import {
  recordDdAttempt,
  recordDdDuration,
  recordDdFailure,
  recordDdFallback,
  recordDdRateLimit,
  recordDdSuccess,
  recordTrackingClickAttempt,
  recordTrackingClickDuration,
  recordTrackingClickFailure,
  recordTrackingClickSuccess,
} from "@/lib/dd-metrics";

describe("dd-metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recordDdAttempt increments dispatch.attempt with site/path tags", () => {
    recordDdAttempt({ site: "acme", path: "http" });
    expect(statsdStub.increment).toHaveBeenCalledWith("dispatch.attempt", 1, [
      "site:acme",
      "path:http",
    ]);
  });

  it("recordDdSuccess increments dispatch.success with site/path tags", () => {
    recordDdSuccess({ site: "acme", path: "browser" });
    expect(statsdStub.increment).toHaveBeenCalledWith("dispatch.success", 1, [
      "site:acme",
      "path:browser",
    ]);
  });

  it("recordDdFailure increments dispatch.failure with error_type tag", () => {
    recordDdFailure({ site: "acme", path: "http", error_type: "timeout" });
    expect(statsdStub.increment).toHaveBeenCalledWith("dispatch.failure", 1, [
      "site:acme",
      "path:http",
      "error_type:timeout",
    ]);
  });

  it("recordDdDuration records dispatch.duration_ms timing with site/path tags", () => {
    recordDdDuration({ site: "acme", path: "http" }, 250);
    expect(statsdStub.timing).toHaveBeenCalledWith("dispatch.duration_ms", 250, [
      "site:acme",
      "path:http",
    ]);
  });

  it("recordDdFallback increments dispatch.fallback with site tag", () => {
    recordDdFallback("acme");
    expect(statsdStub.increment).toHaveBeenCalledWith("dispatch.fallback", 1, ["site:acme"]);
  });

  it("recordDdRateLimit increments dispatch.rate_limit with site tag", () => {
    recordDdRateLimit("acme");
    expect(statsdStub.increment).toHaveBeenCalledWith("dispatch.rate_limit", 1, ["site:acme"]);
  });

  it("recordTrackingClickAttempt increments tracking_click.attempt with site tag", () => {
    recordTrackingClickAttempt("acme");
    expect(statsdStub.increment).toHaveBeenCalledWith("tracking_click.attempt", 1, ["site:acme"]);
  });

  it("recordTrackingClickSuccess increments tracking_click.success with site tag", () => {
    recordTrackingClickSuccess("acme");
    expect(statsdStub.increment).toHaveBeenCalledWith("tracking_click.success", 1, ["site:acme"]);
  });

  it("recordTrackingClickFailure increments tracking_click.failure with site/error_type tags", () => {
    recordTrackingClickFailure("acme", "timeout");
    expect(statsdStub.increment).toHaveBeenCalledWith("tracking_click.failure", 1, [
      "site:acme",
      "error_type:timeout",
    ]);
  });

  it("recordTrackingClickDuration records tracking_click.duration_ms timing with site tag", () => {
    recordTrackingClickDuration("acme", 100);
    expect(statsdStub.timing).toHaveBeenCalledWith("tracking_click.duration_ms", 100, [
      "site:acme",
    ]);
  });
});
