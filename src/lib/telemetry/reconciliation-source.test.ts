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
    joinKeys: { vivclid: "v-9981", jobReference: "56793094457_jid-1" },
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
    joinKeys: { vivclid: "v-9981", jobReference: "56793094457_jid-1" },
    beaconStatus: "fired",
    trackingUrl: "https://track.appcast.io/pixel?rid=req-abc-123",
    durationMs: 87,
    ts: "2026-07-26T10:00:05.000Z",
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
    expect(rows[0]?.beaconTrackingUrl).toBe("https://track.appcast.io/pixel?rid=req-abc-123");
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
