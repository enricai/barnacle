/**
 * Unit tests for the durable reconciliation source. The S3 half is
 * delegated to `submissions-s3-objects.ts`/`submissions-s3-reader.ts` (each
 * covered by its own test suite), so this suite mocks those two modules
 * directly and only exercises the union/dedupe/fold composition against a
 * real temp local sink file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config", () => ({
  config: {
    telemetry: {
      submissionsNdjsonPath: ".barnacle/submissions.ndjson",
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

const listSubmissionsS3ObjectsMock = vi.fn();
vi.mock("@/lib/telemetry/submissions-s3-objects", () => ({
  listSubmissionsS3Objects: (...args: unknown[]) => listSubmissionsS3ObjectsMock(...args),
}));

const fetchSubmissionsS3RecordsMock = vi.fn();
vi.mock("@/lib/telemetry/submissions-s3-reader", () => ({
  fetchSubmissionsS3Records: (...args: unknown[]) => fetchSubmissionsS3RecordsMock(...args),
}));

import { readDurableReconciliationRows } from "@/lib/telemetry/reconciliation-source";
import { readReconciliationRows } from "@/lib/telemetry/submission-reader";

function makeSubmitLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "submit",
    siteId: "ats-c",
    requestId: "req-abc-123",
    joinKeys: { clickId: "v-9981", refId: "56793094457_jid-1" },
    session: null,
    inboundPayload: { jobId: "56793094457" },
    status: "submitted",
    auditPayload: { verified: true },
    errorMessage: null,
    durationMs: 4321,
    ts: "2026-07-26T10:00:00.000Z",
    ...overrides,
  };
}

function makeBeaconLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "beacon",
    requestId: "req-abc-123",
    siteId: "ats-c",
    joinKeys: { clickId: "v-9981", refId: "56793094457_jid-1" },
    beaconStatus: "fired",
    trackingUrl: "https://track.example.com/pixel?rid=req-abc-123",
    durationMs: 87,
    ts: "2026-07-26T10:00:05.000Z",
    sessionIp: null,
    ...overrides,
  };
}

function ndjson(...lines: unknown[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

describe("readDurableReconciliationRows", () => {
  let tmpDir: string;
  let sinkPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reconciliation-source-test-"));
    sinkPath = path.join(tmpDir, "submissions.ndjson");
    listSubmissionsS3ObjectsMock.mockReset();
    fetchSubmissionsS3RecordsMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("dedupes a submit line present in both the local sink and an S3 object into exactly one row", async () => {
    fs.writeFileSync(sinkPath, ndjson(makeSubmitLine()), "utf8");
    listSubmissionsS3ObjectsMock.mockResolvedValue(["telemetry/submissions/2026-07-26/a.ndjson"]);
    fetchSubmissionsS3RecordsMock.mockResolvedValue([makeSubmitLine()]);

    const rows = await readDurableReconciliationRows({ sinkPath });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestId).toBe("req-abc-123");
    expect(rows[0]?.beaconStatus).toBe("not_fired");
  });

  it("folds an S3-only submit line with a local-only beacon line for the same requestId into one row", async () => {
    fs.writeFileSync(sinkPath, ndjson(makeBeaconLine()), "utf8");
    listSubmissionsS3ObjectsMock.mockResolvedValue(["telemetry/submissions/2026-07-26/a.ndjson"]);
    fetchSubmissionsS3RecordsMock.mockResolvedValue([makeSubmitLine()]);

    const rows = await readDurableReconciliationRows({ sinkPath });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestId).toBe("req-abc-123");
    expect(rows[0]?.beaconStatus).toBe("fired");
    expect(rows[0]?.beaconTrackingUrl).toBe("https://track.example.com/pixel?rid=req-abc-123");
  });

  it("keeps a skipped beacon and a fired beacon for the same requestId and ts as two distinct records", async () => {
    // Models the real cross-store race: the local sink already has both
    // dispatch's automatic "skipped" line and the plugin's later
    // self-recorded "fired" line (both share the same second-precision
    // ts), but the S3 replica's flush of "fired" hasn't landed yet — S3 so
    // far only has the exact-duplicate replica of the (now-stale) "skipped"
    // line. Pre-fix, that S3 duplicate shares its dedupe key with BOTH
    // local lines, so its position in mergeRecords' Map (the earlier
    // local "skipped" slot) resurrects "skipped" as the sole survivor and
    // erases the local "fired" knowledge entirely. Post-fix, the S3
    // duplicate only collides with its true match (local "skipped"); the
    // distinctly-keyed local "fired" line survives untouched and wins the
    // fold.
    const ts = "2026-07-27T18:57:25Z";
    const skippedBeacon = makeBeaconLine({ beaconStatus: "skipped", trackingUrl: null, ts });
    const firedBeacon = makeBeaconLine({ beaconStatus: "fired", ts });
    fs.writeFileSync(sinkPath, ndjson(makeSubmitLine(), skippedBeacon, firedBeacon), "utf8");
    listSubmissionsS3ObjectsMock.mockResolvedValue(["telemetry/submissions/2026-07-26/a.ndjson"]);
    fetchSubmissionsS3RecordsMock.mockResolvedValue([skippedBeacon]);

    const rows = await readDurableReconciliationRows({ sinkPath });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestId).toBe("req-abc-123");
    expect(rows[0]?.beaconStatus).toBe("fired");
  });

  it("folds a local skipped beacon and an S3-sourced fired beacon for the same run to fired, even though the local skipped line has a later ts", async () => {
    // The real production shape: submit + dispatch's automatic "skipped"
    // line are both written by the ECS task handling this run, while the
    // plugin's self-recorded "fired" line only ever reaches this reader via
    // the S3 replica (e.g. written by a different task, or not yet flushed to
    // the local sink). The skipped line's ts is deliberately LATER than the
    // fired line's so a timestamp-ordering fold (picking whichever line has
    // the latest ts) would wrongly resurrect "skipped" — only a status-rank
    // fold picks "fired" here.
    const skippedBeacon = makeBeaconLine({
      beaconStatus: "skipped",
      trackingUrl: null,
      ts: "2026-07-26T10:05:00.000Z",
    });
    const firedBeacon = makeBeaconLine({
      beaconStatus: "fired",
      ts: "2026-07-26T10:00:05.000Z",
    });
    fs.writeFileSync(sinkPath, ndjson(makeSubmitLine(), skippedBeacon), "utf8");
    listSubmissionsS3ObjectsMock.mockResolvedValue(["telemetry/submissions/2026-07-26/a.ndjson"]);
    fetchSubmissionsS3RecordsMock.mockResolvedValue([firedBeacon]);

    const rows = await readDurableReconciliationRows({ sinkPath });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestId).toBe("req-abc-123");
    expect(rows[0]?.beaconStatus).toBe("fired");
    expect(rows[0]?.beaconTrackingUrl).toBe("https://track.example.com/pixel?rid=req-abc-123");
  });

  it("folds the replicated arrangement — local fired beacon, S3-sourced skipped beacon — to the same fired row", async () => {
    // Same run, opposite store membership from the previous case: proves the
    // precedence rule depends on beaconRank, not on which store (or which
    // union position) a line happens to come from. The skipped line again
    // carries the later ts to rule out a timestamp-ordering fold.
    const firedBeacon = makeBeaconLine({
      ts: "2026-07-26T10:00:05.000Z",
    });
    const skippedBeacon = makeBeaconLine({
      beaconStatus: "skipped",
      trackingUrl: null,
      ts: "2026-07-26T10:05:00.000Z",
    });
    fs.writeFileSync(sinkPath, ndjson(makeSubmitLine(), firedBeacon), "utf8");
    listSubmissionsS3ObjectsMock.mockResolvedValue(["telemetry/submissions/2026-07-26/a.ndjson"]);
    fetchSubmissionsS3RecordsMock.mockResolvedValue([skippedBeacon]);

    const rows = await readDurableReconciliationRows({ sinkPath });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestId).toBe("req-abc-123");
    expect(rows[0]?.beaconStatus).toBe("fired");
    expect(rows[0]?.beaconTrackingUrl).toBe("https://track.example.com/pixel?rid=req-abc-123");
  });

  it("still collapses an exact-duplicate beacon line present in both the local sink and an S3 object", async () => {
    const beacon = makeBeaconLine();
    fs.writeFileSync(sinkPath, ndjson(makeSubmitLine(), beacon), "utf8");
    listSubmissionsS3ObjectsMock.mockResolvedValue(["telemetry/submissions/2026-07-26/a.ndjson"]);
    fetchSubmissionsS3RecordsMock.mockResolvedValue([beacon]);

    const rows = await readDurableReconciliationRows({ sinkPath });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestId).toBe("req-abc-123");
    expect(rows[0]?.beaconStatus).toBe("fired");
    expect(rows[0]?.beaconTrackingUrl).toBe("https://track.example.com/pixel?rid=req-abc-123");
  });

  it("matches readReconciliationRows byte-for-byte when the S3 source contributes nothing", async () => {
    fs.writeFileSync(sinkPath, ndjson(makeSubmitLine(), makeBeaconLine()), "utf8");
    listSubmissionsS3ObjectsMock.mockResolvedValue([]);

    const [durableRows, localOnlyRows] = await Promise.all([
      readDurableReconciliationRows({ sinkPath }),
      readReconciliationRows({ sinkPath }),
    ]);

    expect(durableRows).toEqual(localOnlyRows);
    expect(fetchSubmissionsS3RecordsMock).not.toHaveBeenCalled();
  });

  it("returns the local rows unchanged when the S3 object listing rejects", async () => {
    fs.writeFileSync(sinkPath, ndjson(makeSubmitLine()), "utf8");
    listSubmissionsS3ObjectsMock.mockRejectedValue(new Error("access denied"));

    const rows = await readDurableReconciliationRows({ sinkPath });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestId).toBe("req-abc-123");
  });

  it("returns the local rows unchanged when the S3 object fetch rejects", async () => {
    fs.writeFileSync(sinkPath, ndjson(makeSubmitLine({ requestId: "req-local-only" })), "utf8");
    listSubmissionsS3ObjectsMock.mockResolvedValue(["telemetry/submissions/2026-07-26/a.ndjson"]);
    fetchSubmissionsS3RecordsMock.mockRejectedValue(new Error("network error"));

    const rows = await readDurableReconciliationRows({ sinkPath });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestId).toBe("req-local-only");
  });

  it("returns an empty array when neither store has any rows", async () => {
    listSubmissionsS3ObjectsMock.mockResolvedValue([]);

    const rows = await readDurableReconciliationRows({ sinkPath });

    expect(rows).toEqual([]);
  });
});
