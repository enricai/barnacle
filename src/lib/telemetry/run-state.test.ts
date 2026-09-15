import { beforeEach, describe, expect, it } from "vitest";
import { getTelemetryState, resetTelemetryState, setTelemetryState } from "@/lib/telemetry/run-state";

describe("run-state", () => {
  beforeEach(() => {
    resetTelemetryState();
  });

  it("returns the default state", () => {
    expect(getTelemetryState()).toEqual({
      currentRunFile: null,
      currentRunFileSizeBytes: 0,
      orphansRecovered: 0,
    });
  });

  it("shallow merges a partial update into the existing state", () => {
    setTelemetryState({ currentRunFile: "/tmp/run.ndjson" });
    setTelemetryState({ currentRunFileSizeBytes: 42 });

    expect(getTelemetryState()).toEqual({
      currentRunFile: "/tmp/run.ndjson",
      currentRunFileSizeBytes: 42,
      orphansRecovered: 0,
    });
  });

  it("restores the defaults after mutation", () => {
    setTelemetryState({ currentRunFile: "/tmp/run.ndjson", currentRunFileSizeBytes: 42, orphansRecovered: 3 });

    resetTelemetryState();

    expect(getTelemetryState()).toEqual({
      currentRunFile: null,
      currentRunFileSizeBytes: 0,
      orphansRecovered: 0,
    });
  });
});
