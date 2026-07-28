/**
 * Round-trip integration test: the real `captureSubmissionEnvelope` and
 * `captureBeaconEvent` writers, pointed at a temp sink, feeding the real
 * `readReconciliationRows`/`queryReconciliationRows` readers. Every other
 * suite mocks one side of this seam (loader.test.ts mocks
 * `captureSubmissionEnvelope`; the route test mocks the reader), so a field
 * renamed on the writer but not the reader (or vice versa) would pass every
 * other suite and only surface here.
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

import { captureBeaconEvent } from "@/lib/telemetry/beacon-capture";
import { captureSubmissionEnvelope } from "@/lib/telemetry/submission-capture";
import { queryReconciliationRows } from "@/lib/telemetry/submission-query";
import { readReconciliationRows } from "@/lib/telemetry/submission-reader";

let tmpDir: string;
let sinkPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reconciliation-roundtrip-test-"));
  sinkPath = path.join(tmpDir, "submissions.ndjson");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("submission + beacon round-trip through the real writer and reader", () => {
  it("a submitted envelope and its fired beacon come back as one row carrying every join key", async () => {
    await captureSubmissionEnvelope(
      {
        siteId: "hca",
        requestId: "req-fired-1",
        joinKeys: { vivclid: "viv-fired-1", jobReference: "emp1_jid1" },
        inboundPayload: { jobId: "jid1", ClickUrl: "https://example.com/apply" },
        status: "submitted",
        auditPayload: { verified: true, applicationId: "app-1" },
        errorMessage: null,
        durationMs: 321,
      },
      { sinkPath }
    );
    await captureBeaconEvent(
      {
        requestId: "req-fired-1",
        siteId: "hca",
        joinKeys: { vivclid: "viv-fired-1", jobReference: "emp1_jid1" },
        beaconStatus: "fired",
        trackingUrl: "https://track.appcast.io/pixel?rid=req-fired-1",
        durationMs: 42,
      },
      { sinkPath }
    );

    const rows = await readReconciliationRows({ sinkPath });
    const byRequestId = queryReconciliationRows(rows, { requestId: "req-fired-1" });

    expect(byRequestId).toHaveLength(1);
    const [row] = byRequestId;
    expect(row?.joinKeys).toEqual({ vivclid: "viv-fired-1", jobReference: "emp1_jid1" });
    expect(row?.siteId).toBe("hca");
    expect(row?.status).toBe("submitted");
    expect(row?.beaconStatus).toBe("fired");
  });

  it("distinguishes a submitted-but-beacon-failed run from a submitted-and-beacon-fired run", async () => {
    await captureSubmissionEnvelope(
      {
        siteId: "hca",
        requestId: "req-fired-2",
        joinKeys: { vivclid: "viv-fired-2", jobReference: "emp2_jid2" },
        inboundPayload: { jobId: "jid2" },
        status: "submitted",
        auditPayload: { verified: true, applicationId: "app-2" },
        errorMessage: null,
        durationMs: 200,
      },
      { sinkPath }
    );
    await captureBeaconEvent(
      {
        requestId: "req-fired-2",
        siteId: "hca",
        joinKeys: { vivclid: "viv-fired-2", jobReference: "emp2_jid2" },
        beaconStatus: "fired",
        trackingUrl: "https://track.appcast.io/pixel?rid=req-fired-2",
        durationMs: 30,
      },
      { sinkPath }
    );

    await captureSubmissionEnvelope(
      {
        siteId: "hca",
        requestId: "req-failed-3",
        joinKeys: { vivclid: "viv-failed-3", jobReference: "emp3_jid3" },
        inboundPayload: { jobId: "jid3" },
        status: "submitted",
        auditPayload: { verified: true, applicationId: "app-3" },
        errorMessage: null,
        durationMs: 210,
      },
      { sinkPath }
    );
    await captureBeaconEvent(
      {
        requestId: "req-failed-3",
        siteId: "hca",
        joinKeys: { vivclid: "viv-failed-3", jobReference: "emp3_jid3" },
        beaconStatus: "failed",
        trackingUrl: null,
        durationMs: 15,
      },
      { sinkPath }
    );

    const rows = await readReconciliationRows({ sinkPath });

    const firedRow = queryReconciliationRows(rows, { requestId: "req-fired-2" })[0];
    const failedRow = queryReconciliationRows(rows, { requestId: "req-failed-3" })[0];

    expect(firedRow?.status).toBe("submitted");
    expect(failedRow?.status).toBe("submitted");
    expect(firedRow?.beaconStatus).toBe("fired");
    expect(failedRow?.beaconStatus).toBe("failed");
    expect(firedRow?.beaconStatus).not.toBe(failedRow?.beaconStatus);

    const onlyFired = queryReconciliationRows(rows, { beaconStatus: "fired" });
    const onlyFailed = queryReconciliationRows(rows, { beaconStatus: "failed" });
    expect(onlyFired.map((r) => r.requestId)).toEqual(["req-fired-2"]);
    expect(onlyFailed.map((r) => r.requestId)).toEqual(["req-failed-3"]);
  });

  it("round-trips a skipped beacon's trackingUrl distinctly for 'no URL was ever applicable' vs. 'a plugin managing its own tracking nav delegated it'", async () => {
    await captureSubmissionEnvelope(
      {
        siteId: "appcast",
        requestId: "req-skipped-delegated",
        joinKeys: { vivclid: "viv-delegated", jobReference: "emp4_jid4" },
        inboundPayload: { jobId: "jid4", TrackingUrl: "https://track.appcast.io/t/abc" },
        status: "submitted",
        auditPayload: { verified: true, applicationId: "app-4" },
        errorMessage: null,
        durationMs: 190,
      },
      { sinkPath }
    );
    await captureBeaconEvent(
      {
        requestId: "req-skipped-delegated",
        siteId: "appcast",
        joinKeys: { vivclid: "viv-delegated", jobReference: "emp4_jid4" },
        beaconStatus: "skipped",
        trackingUrl: "https://track.appcast.io/t/abc",
        durationMs: 0,
      },
      { sinkPath }
    );

    await captureSubmissionEnvelope(
      {
        siteId: "hca",
        requestId: "req-skipped-no-url",
        joinKeys: null,
        inboundPayload: { jobId: "jid5" },
        status: "submitted",
        auditPayload: { verified: true, applicationId: "app-5" },
        errorMessage: null,
        durationMs: 175,
      },
      { sinkPath }
    );
    await captureBeaconEvent(
      {
        requestId: "req-skipped-no-url",
        siteId: "hca",
        joinKeys: null,
        beaconStatus: "skipped",
        trackingUrl: null,
        durationMs: 0,
      },
      { sinkPath }
    );

    const rows = await readReconciliationRows({ sinkPath });

    const delegatedRow = queryReconciliationRows(rows, { requestId: "req-skipped-delegated" })[0];
    const noUrlRow = queryReconciliationRows(rows, { requestId: "req-skipped-no-url" })[0];

    expect(delegatedRow?.beaconStatus).toBe("skipped");
    expect(delegatedRow?.beaconTrackingUrl).toBe("https://track.appcast.io/t/abc");

    expect(noUrlRow?.beaconStatus).toBe("skipped");
    expect(noUrlRow?.beaconTrackingUrl).toBeNull();

    const onlySkipped = queryReconciliationRows(rows, { beaconStatus: "skipped" });
    expect(onlySkipped.map((r) => r.requestId).sort()).toEqual([
      "req-skipped-delegated",
      "req-skipped-no-url",
    ]);
  });

  it("round-trips a submitted envelope's session.ip and merged joinKeys bag through the real writer and reader", async () => {
    const session = {
      id: "bb-session-roundtrip",
      provider: "browserbase",
      ip: "203.0.113.77",
      ipCapturedAt: "2026-07-26T10:00:01.000Z",
    };
    await captureSubmissionEnvelope(
      {
        siteId: "hca",
        requestId: "req-session-roundtrip",
        joinKeys: { vivclid: "viv-roundtrip", jobReference: "emp9_jid9" },
        session,
        inboundPayload: { jobId: "jid9" },
        status: "submitted",
        auditPayload: { verified: true, applicationId: "app-9" },
        errorMessage: null,
        durationMs: 250,
      },
      { sinkPath }
    );
    await captureBeaconEvent(
      {
        requestId: "req-session-roundtrip",
        siteId: "hca",
        joinKeys: { vivclid: "viv-roundtrip", jobReference: "emp9_jid9" },
        beaconStatus: "fired",
        trackingUrl: "https://track.appcast.io/pixel?rid=req-session-roundtrip",
        durationMs: 12,
        sessionIp: "198.51.100.77",
      },
      { sinkPath }
    );

    const rows = await readReconciliationRows({ sinkPath });
    const [row] = queryReconciliationRows(rows, { requestId: "req-session-roundtrip" });

    expect(row?.session).toEqual(session);
    expect(row?.session?.ip).toBe("203.0.113.77");
    expect(row?.joinKeys).toEqual({ vivclid: "viv-roundtrip", jobReference: "emp9_jid9" });
    expect(row?.beaconSessionIp).toBe("198.51.100.77");
  });
});
