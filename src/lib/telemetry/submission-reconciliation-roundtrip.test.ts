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
        vivclid: "viv-fired-1",
        jobReference: "emp1_jid1",
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
        vivclid: "viv-fired-1",
        jobReference: "emp1_jid1",
        beaconStatus: "fired",
        trackingUrl: "https://track.appcast.io/pixel?rid=req-fired-1",
        durationMs: 42,
      },
      { sinkPath }
    );

    const rows = await readReconciliationRows({ sinkPath });
    const byVivclid = queryReconciliationRows(rows, { vivclid: "viv-fired-1" });

    expect(byVivclid).toHaveLength(1);
    const [row] = byVivclid;
    expect(row?.vivclid).toBe("viv-fired-1");
    expect(row?.siteId).toBe("hca");
    expect(row?.jobReference).toBe("emp1_jid1");
    expect(row?.status).toBe("submitted");
    expect(row?.beaconStatus).toBe("fired");

    const byJobReference = queryReconciliationRows(rows, { jobReference: "emp1_jid1" });
    expect(byJobReference).toHaveLength(1);
    expect(byJobReference[0]?.requestId).toBe(row?.requestId);
  });

  it("distinguishes a submitted-but-beacon-failed run from a submitted-and-beacon-fired run", async () => {
    await captureSubmissionEnvelope(
      {
        siteId: "hca",
        requestId: "req-fired-2",
        vivclid: "viv-fired-2",
        jobReference: "emp2_jid2",
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
        vivclid: "viv-fired-2",
        jobReference: "emp2_jid2",
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
        vivclid: "viv-failed-3",
        jobReference: "emp3_jid3",
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
        vivclid: "viv-failed-3",
        jobReference: "emp3_jid3",
        beaconStatus: "failed",
        trackingUrl: null,
        durationMs: 15,
      },
      { sinkPath }
    );

    const rows = await readReconciliationRows({ sinkPath });

    const firedRow = queryReconciliationRows(rows, { vivclid: "viv-fired-2" })[0];
    const failedRow = queryReconciliationRows(rows, { vivclid: "viv-failed-3" })[0];

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
});
