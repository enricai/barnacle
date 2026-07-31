import { describe, expect, it } from "vitest";

import { RunTelemetry } from "@/lib/telemetry/run-telemetry";

describe("RunTelemetry", () => {
  it("snapshot() starts with joinKeys null and session null", () => {
    const telemetry = new RunTelemetry();

    expect(telemetry.snapshot()).toEqual({ joinKeys: null, session: null });
  });

  it("addJoinKeys() merges across calls with later keys winning on collision", () => {
    const telemetry = new RunTelemetry();

    telemetry.addJoinKeys({ foo: "first", kept: "yes" });
    telemetry.addJoinKeys({ foo: "second" });

    expect(telemetry.snapshot().joinKeys).toEqual({ foo: "second", kept: "yes" });
  });

  it("recordSession() is whole-object last-write-wins", () => {
    const telemetry = new RunTelemetry();

    telemetry.recordSession({
      sessionId: "sess-1",
      provider: "browserbase",
      ip: null,
      ipCapturedAt: null,
    });
    telemetry.recordSession({
      sessionId: "sess-2",
      provider: "browserbase",
      ip: "203.0.113.42",
      ipCapturedAt: "2026-07-28T00:00:00Z",
    });

    expect(telemetry.snapshot().session).toEqual({
      sessionId: "sess-2",
      provider: "browserbase",
      ip: "203.0.113.42",
      ipCapturedAt: "2026-07-28T00:00:00Z",
    });
  });

  it("snapshot() returns a defensive copy that mutation does not affect the collector", () => {
    const telemetry = new RunTelemetry();
    telemetry.addJoinKeys({ foo: "bar" });
    telemetry.recordSession({
      sessionId: "sess-1",
      provider: "browserbase",
      ip: "203.0.113.42",
      ipCapturedAt: "2026-07-28T00:00:00Z",
    });

    const snapshot = telemetry.snapshot();
    if (snapshot.joinKeys) snapshot.joinKeys.foo = "mutated";
    if (snapshot.session) snapshot.session.ip = "mutated";

    expect(telemetry.snapshot()).toEqual({
      joinKeys: { foo: "bar" },
      session: {
        sessionId: "sess-1",
        provider: "browserbase",
        ip: "203.0.113.42",
        ipCapturedAt: "2026-07-28T00:00:00Z",
      },
    });
  });
});
