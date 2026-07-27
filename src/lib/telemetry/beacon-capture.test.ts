/**
 * Unit tests for the beacon-event NDJSON writer. All tests write to a temp
 * directory so no real `.barnacle/` directory is touched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  }),
}));

vi.mock("@/lib/telemetry/s3-sink", () => ({
  bufferSubmissionLine: vi.fn(),
}));

import { type BeaconEventSample, captureBeaconEvent } from "@/lib/telemetry/beacon-capture";
import { beaconEventSchema } from "@/lib/telemetry/reconciliation-record";
import { bufferSubmissionLine } from "@/lib/telemetry/s3-sink";

function makeFiredInput(): Parameters<typeof captureBeaconEvent>[0] {
  return {
    requestId: "req-abc-123",
    siteId: "ats-c",
    vivclid: "v-9981",
    jobReference: "56793094457_jid-1",
    beaconStatus: "fired",
    trackingUrl: "https://track.appcast.io/pixel?rid=req-abc-123",
    durationMs: 842,
  };
}

function makeFailedInput(): Parameters<typeof captureBeaconEvent>[0] {
  return {
    requestId: "req-def-456",
    siteId: "ats-c",
    vivclid: null,
    jobReference: null,
    beaconStatus: "failed",
    trackingUrl: null,
    durationMs: 120,
  };
}

let tmpDir: string;
let sinkPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "beacon-capture-test-"));
  sinkPath = path.join(tmpDir, "submissions.ndjson");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("captureBeaconEvent", () => {
  it("appends exactly one kind:beacon line to the sink", async () => {
    await captureBeaconEvent(makeFiredInput(), { sinkPath });

    const content = fs.readFileSync(sinkPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0] ?? "{}") as BeaconEventSample;
    expect(parsed.kind).toBe("beacon");
  });

  it("the appended line parses against beaconEventSchema", async () => {
    await captureBeaconEvent(makeFiredInput(), { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const result = beaconEventSchema.safeParse(JSON.parse(line));
    expect(result.success).toBe(true);
  });

  it("a failed beaconStatus writes the same shape", async () => {
    await captureBeaconEvent(makeFailedInput(), { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as BeaconEventSample;
    expect(parsed.kind).toBe("beacon");
    expect(parsed.beaconStatus).toBe("failed");
    expect(parsed.trackingUrl).toBeNull();

    const result = beaconEventSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it("preserves requestId, siteId, vivclid, jobReference, and derives ts", async () => {
    const input = makeFiredInput();
    await captureBeaconEvent(input, { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as BeaconEventSample;
    expect(parsed.requestId).toBe(input.requestId);
    expect(parsed.siteId).toBe(input.siteId);
    expect(parsed.vivclid).toBe(input.vivclid);
    expect(parsed.jobReference).toBe(input.jobReference);
    expect(parsed.durationMs).toBe(input.durationMs);
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("truncates trackingUrl to 120 characters but keeps vivclid in full", async () => {
    const longUrl = `https://track.appcast.io/pixel?rid=${"x".repeat(200)}`;
    const input = {
      ...makeFiredInput(),
      trackingUrl: longUrl,
      vivclid: "v-".concat("y".repeat(200)),
    };
    await captureBeaconEvent(input, { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as BeaconEventSample;
    expect(parsed.trackingUrl).toBe(longUrl.slice(0, 120));
    expect(parsed.trackingUrl?.length).toBe(120);
    expect(parsed.vivclid).toBe(input.vivclid);
  });

  it("line is terminated by a newline character", async () => {
    await captureBeaconEvent(makeFiredInput(), { sinkPath });

    const content = fs.readFileSync(sinkPath, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("creates the sink directory if it does not exist", async () => {
    const nestedSink = path.join(tmpDir, "deep", "nested", "submissions.ndjson");
    await captureBeaconEvent(makeFiredInput(), { sinkPath: nestedSink });

    expect(fs.existsSync(nestedSink)).toBe(true);
  });

  it("forwards the exact serialized line to the S3 submission buffer", async () => {
    await captureBeaconEvent(makeFiredInput(), { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8");
    expect(bufferSubmissionLine).toHaveBeenCalledTimes(1);
    expect(bufferSubmissionLine).toHaveBeenCalledWith(line);
  });

  it("appends a beacon line onto an existing submissions sink without disturbing prior lines", async () => {
    fs.writeFileSync(sinkPath, `${JSON.stringify({ kind: "submit", requestId: "req-abc-123" })}\n`);

    await captureBeaconEvent(makeFiredInput(), { sinkPath });

    const content = fs.readFileSync(sinkPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}").kind).toBe("submit");
    expect(JSON.parse(lines[1] ?? "{}").kind).toBe("beacon");
  });

  it("logs and swallows a sink write error instead of rejecting", async () => {
    const badSinkPath = path.join(tmpDir, "not-a-dir\0invalid", "submissions.ndjson");

    await expect(
      captureBeaconEvent(makeFiredInput(), { sinkPath: badSinkPath })
    ).resolves.toBeUndefined();
  });
});
