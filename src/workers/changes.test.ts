import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "@/config";
import { getSailingPackages } from "@/services/sailing-catalog";
import { runChangeDetection, startChangesWorker } from "@/workers/changes";

// Hoisted logger stub so the module-level getLogger in changes.ts picks
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
 * The hourly changes worker keeps snapshot rows fresh so the delta
 * endpoints return meaningful diffs. It's a narrower sweep than the
 * refresh worker (60 days vs 12 months) — we lock that boundary here
 * along with the same opt-out + error-isolation invariants.
 */

vi.mock("@/services/sailing-catalog", () => ({
  getSailingPackages: vi.fn(),
}));

describe("workers/changes startChangesWorker", () => {
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
    expect(startChangesWorker()).toBeNull();
  });

  it("returns a Cron instance when workers are enabled", () => {
    Object.defineProperty(config.workers, "enabled", {
      value: true,
      configurable: true,
      writable: true,
    });
    const job = startChangesWorker();
    try {
      expect(job).not.toBeNull();
      expect(job?.name).toBe("changes");
    } finally {
      job?.stop();
    }
  });
});

describe("workers/changes runChangeDetection", () => {
  beforeEach(() => {
    vi.mocked(getSailingPackages).mockReset();
  });

  it("sweeps both supported brands", async () => {
    vi.mocked(getSailingPackages).mockResolvedValue({
      status: { httpStatus: "OK", dateTime: "2026-01-01T00:00:00", details: [] },
      sailingPackages: [],
    });
    await runChangeDetection();
    expect(vi.mocked(getSailingPackages)).toHaveBeenCalledTimes(2);
    const brands = vi.mocked(getSailingPackages).mock.calls.map((c) => c[0].brandCode);
    expect(brands).toEqual(["R", "C"]);
  });

  it("uses a 60-day forward window sized for the hourly cadence", async () => {
    vi.mocked(getSailingPackages).mockResolvedValue({
      status: { httpStatus: "OK", dateTime: "2026-01-01T00:00:00", details: [] },
      sailingPackages: [],
    });
    await runChangeDetection();
    const first = vi.mocked(getSailingPackages).mock.calls[0]?.[0];
    const fromDate = new Date(`${first?.fromSailDate}T00:00:00Z`);
    const toDate = new Date(`${first?.toSailDate}T00:00:00Z`);
    const days = Math.round((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000));
    expect(days).toBe(60);
  });

  it("continues after a per-brand failure", async () => {
    vi.mocked(getSailingPackages)
      .mockRejectedValueOnce(new Error("R sweep failed"))
      .mockResolvedValueOnce({
        status: { httpStatus: "OK", dateTime: "2026-01-01T00:00:00", details: [] },
        sailingPackages: [],
      });
    await expect(runChangeDetection()).resolves.toBeUndefined();
    expect(vi.mocked(getSailingPackages)).toHaveBeenCalledTimes(2);
  });

  it("emits a succeeded log per brand + a sweep-complete summary", async () => {
    loggerStub.info.mockClear();
    vi.mocked(getSailingPackages).mockResolvedValue({
      status: { httpStatus: "OK", dateTime: "2026-01-01T00:00:00", details: [] },
      sailingPackages: [],
    });
    await runChangeDetection();
    const messages = loggerStub.info.mock.calls.map((c) => c[0] as string);
    expect(messages.filter((m) => /changes sweep succeeded/.test(m))).toHaveLength(2);
    expect(messages.some((m) => /changes sweep complete:\s+ok=2\s+failed=0/.test(m))).toBe(true);
  });

  it("emits a warn log per brand failure and a sweep-complete with failed counter", async () => {
    loggerStub.warn.mockClear();
    loggerStub.info.mockClear();
    vi.mocked(getSailingPackages)
      .mockRejectedValueOnce(new Error("R exploded"))
      .mockRejectedValueOnce(new Error("C exploded"));
    await runChangeDetection();
    expect(loggerStub.warn).toHaveBeenCalledTimes(2);
    const summary = loggerStub.info.mock.calls
      .map((c) => c[0] as string)
      .find((m) => /changes sweep complete/.test(m));
    expect(summary).toMatch(/ok=0\s+failed=2/);
  });
});
