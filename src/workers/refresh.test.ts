import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "@/config";
import { getSailingPackages } from "@/services/sailing-catalog";
import { runRefresh, startRefreshWorker } from "@/workers/refresh";

// Hoisted logger stub so the module-level getLogger in refresh.ts picks
// it up; lets us assert on observability signals ops depend on.
const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({ getLogger: () => loggerStub }));

/**
 * The refresh worker warms the snapshot table so the delta endpoints
 * have data to diff against. Tests cover the two load-bearing
 * properties: (1) scheduling opt-out when workers are disabled,
 * (2) the sweep iterates every brand and survives a per-brand failure
 * so one brand's outage doesn't mute all downstream deltas.
 */

vi.mock("@/services/sailing-catalog", () => ({
  getSailingPackages: vi.fn(),
}));

describe("workers/refresh startRefreshWorker", () => {
  const originalEnabled = config.workers.enabled;

  afterEach(() => {
    Object.defineProperty(config.workers, "enabled", {
      value: originalEnabled,
      configurable: true,
      writable: true,
    });
  });

  it("returns null and schedules nothing when workers are disabled", () => {
    Object.defineProperty(config.workers, "enabled", {
      value: false,
      configurable: true,
      writable: true,
    });
    expect(startRefreshWorker()).toBeNull();
  });

  it("returns a Cron instance when workers are enabled", () => {
    Object.defineProperty(config.workers, "enabled", {
      value: true,
      configurable: true,
      writable: true,
    });
    const job = startRefreshWorker();
    try {
      expect(job).not.toBeNull();
      expect(job?.name).toBe("refresh");
    } finally {
      job?.stop();
    }
  });
});

describe("workers/refresh runRefresh", () => {
  beforeEach(() => {
    vi.mocked(getSailingPackages).mockReset();
  });

  it("invokes getSailingPackages once per supported brand", async () => {
    vi.mocked(getSailingPackages).mockResolvedValue({
      status: { httpStatus: "OK", dateTime: "2026-01-01T00:00:00", details: [] },
      sailingPackages: [],
    });
    await runRefresh();
    expect(vi.mocked(getSailingPackages)).toHaveBeenCalledTimes(2);
    const brands = vi.mocked(getSailingPackages).mock.calls.map((c) => c[0].brandCode);
    expect(brands).toEqual(["R", "C"]);
  });

  it("forwards a 12-month forward window using ISO dates", async () => {
    vi.mocked(getSailingPackages).mockResolvedValue({
      status: { httpStatus: "OK", dateTime: "2026-01-01T00:00:00", details: [] },
      sailingPackages: [],
    });
    await runRefresh();
    const first = vi.mocked(getSailingPackages).mock.calls[0]?.[0];
    expect(first?.fromSailDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first?.toSailDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first?.includeTourPackages).toBe(false);
  });

  it("continues to the next brand when one brand throws", async () => {
    vi.mocked(getSailingPackages)
      .mockRejectedValueOnce(new Error("R refresh failed"))
      .mockResolvedValueOnce({
        status: { httpStatus: "OK", dateTime: "2026-01-01T00:00:00", details: [] },
        sailingPackages: [],
      });
    await expect(runRefresh()).resolves.toBeUndefined();
    expect(vi.mocked(getSailingPackages)).toHaveBeenCalledTimes(2);
  });

  // Observability pins: ops alerts depend on "succeeded" and "sweep
  // complete" log lines. Without these assertions a refactor could
  // silence the signal without any existing test failing.
  it("emits a succeeded log with sailings count per brand + a sweep-complete summary", async () => {
    loggerStub.info.mockClear();
    vi.mocked(getSailingPackages).mockResolvedValue({
      status: { httpStatus: "OK", dateTime: "2026-01-01T00:00:00", details: [] },
      sailingPackages: [
        { brandCode: "R", shipCode: "RD", sailDate: "2026-06-01", packageCode: "P1", duration: 7 },
      ],
    });
    await runRefresh();
    const messages = loggerStub.info.mock.calls.map((c) => c[0] as string);
    // One succeeded log per brand (2) + one sweep-complete.
    expect(messages.filter((m) => /refresh succeeded/.test(m))).toHaveLength(2);
    expect(messages.some((m) => /sailings=1/.test(m))).toBe(true);
    expect(messages.some((m) => /refresh sweep complete:\s+ok=2\s+failed=0/.test(m))).toBe(true);
  });

  it("emits a warn log per brand failure and a sweep-complete with failed counter", async () => {
    loggerStub.warn.mockClear();
    loggerStub.info.mockClear();
    vi.mocked(getSailingPackages)
      .mockRejectedValueOnce(new Error("R exploded"))
      .mockRejectedValueOnce(new Error("C exploded"));
    await runRefresh();
    expect(loggerStub.warn).toHaveBeenCalledTimes(2);
    const summary = loggerStub.info.mock.calls
      .map((c) => c[0] as string)
      .find((m) => /refresh sweep complete/.test(m));
    expect(summary).toMatch(/ok=0\s+failed=2/);
  });
});
