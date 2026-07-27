/**
 * Unit tests for the plugin-facing beacon-outcome recorder. Real writes go
 * through the actual `captureBeaconEvent` (wrapped, not replaced) so (a)/(b)
 * prove a genuine NDJSON round-trip; `mockImplementationOnce`/
 * `mockRejectedValueOnce` override that wrapper per-test to prove the
 * never-throws contract in (c).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  errorWithStack: vi.fn(),
}));

vi.mock("@/config", () => ({
  config: {
    telemetry: {
      submissionsNdjsonPath: ".barnacle/submissions.ndjson",
      s3: {
        bucket: undefined,
      },
    },
  },
}));

vi.mock("@/lib/logging", () => ({
  getLogger: () => mockLogger,
}));

vi.mock("@/lib/telemetry/s3-sink", () => ({
  bufferSubmissionLine: vi.fn(),
}));

vi.mock("@/lib/telemetry/beacon-capture", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/telemetry/beacon-capture")>(
      "@/lib/telemetry/beacon-capture"
    );
  return {
    ...actual,
    captureBeaconEvent: vi.fn(actual.captureBeaconEvent),
  };
});

import { captureBeaconEvent } from "@/lib/telemetry/beacon-capture";
import { recordBeaconOutcome } from "@/lib/telemetry/beacon-outcome";
import { reconciliationRecordSchema } from "@/lib/telemetry/reconciliation-record";

const mockCaptureBeaconEvent = vi.mocked(captureBeaconEvent);

let tmpDir: string;
let sinkPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "beacon-outcome-test-"));
  sinkPath = path.join(tmpDir, "submissions.ndjson");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("recordBeaconOutcome", () => {
  it("records a fired outcome that parses as kind:beacon with joinKeys intact", async () => {
    const joinKeys = { vivclid: "v-1", jobReference: "56793094457_jid-1" };

    await recordBeaconOutcome(
      {
        requestId: "req-1",
        siteId: "ats-c",
        beaconStatus: "fired",
        joinKeys,
        trackingUrl: "https://track.example.com/pixel?rid=req-1",
        durationMs: 842,
      },
      { sinkPath }
    );

    const lines = fs
      .readFileSync(sinkPath, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);

    const parsed = reconciliationRecordSchema.parse(JSON.parse(lines[0] ?? "{}"));
    if (parsed.kind !== "beacon") throw new Error("expected a beacon record");
    expect(parsed.beaconStatus).toBe("fired");
    expect(parsed.requestId).toBe("req-1");
    expect(parsed.siteId).toBe("ats-c");
    expect(parsed.joinKeys).toEqual(joinKeys);
    expect(parsed.trackingUrl).toBe("https://track.example.com/pixel?rid=req-1");
    expect(parsed.durationMs).toBe(842);
  });

  it("records a failed outcome that round-trips likewise", async () => {
    const joinKeys = { vivclid: "v-2" };

    await recordBeaconOutcome(
      {
        requestId: "req-2",
        siteId: "ats-c",
        beaconStatus: "failed",
        joinKeys,
        durationMs: 120,
      },
      { sinkPath }
    );

    const lines = fs
      .readFileSync(sinkPath, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);

    const parsed = reconciliationRecordSchema.parse(JSON.parse(lines[0] ?? "{}"));
    if (parsed.kind !== "beacon") throw new Error("expected a beacon record");
    expect(parsed.beaconStatus).toBe("failed");
    expect(parsed.joinKeys).toEqual(joinKeys);
    expect(parsed.trackingUrl).toBeNull();
  });

  it("defaults an omitted trackingUrl/durationMs to null/0", async () => {
    await recordBeaconOutcome(
      { requestId: "req-5", siteId: "ats-c", beaconStatus: "fired", joinKeys: null },
      { sinkPath }
    );

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = reconciliationRecordSchema.parse(JSON.parse(line));
    if (parsed.kind !== "beacon") throw new Error("expected a beacon record");
    expect(parsed.trackingUrl).toBeNull();
    expect(parsed.durationMs).toBe(0);
  });

  it("resolves without throwing and logs a warning when captureBeaconEvent throws synchronously", async () => {
    mockCaptureBeaconEvent.mockImplementationOnce(() => {
      throw new Error("boom-sync");
    });

    await expect(
      recordBeaconOutcome(
        { requestId: "req-3", siteId: "ats-c", beaconStatus: "fired", joinKeys: null },
        { sinkPath }
      )
    ).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("boom-sync"));
    expect(fs.existsSync(sinkPath)).toBe(false);
  });

  it("resolves without throwing and logs a warning when captureBeaconEvent rejects", async () => {
    mockCaptureBeaconEvent.mockRejectedValueOnce(new Error("boom-reject"));

    await expect(
      recordBeaconOutcome(
        { requestId: "req-4", siteId: "ats-c", beaconStatus: "failed", joinKeys: null },
        { sinkPath }
      )
    ).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("boom-reject"));
  });
});
