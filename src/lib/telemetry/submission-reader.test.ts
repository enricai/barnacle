/**
 * Unit tests for the submissions-sink reader/fold. Pure-function tests run
 * against fixture NDJSON strings with no I/O; the `readReconciliationRows`
 * tests write to a temp directory so no real `.barnacle/` directory is
 * touched.
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

import {
  foldReconciliationRecords,
  parseReconciliationLines,
  readReconciliationRows,
} from "@/lib/telemetry/submission-reader";

function makeSubmitLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "submit",
    siteId: "ats-c",
    requestId: "req-abc-123",
    vivclid: "v-9981",
    jobReference: "56793094457_jid-1",
    inboundPayload: { jobId: "56793094457", ClickUrl: "https://example.com/apply" },
    status: "submitted",
    auditPayload: { verified: true, applicationId: "app-xyz" },
    errorMessage: null,
    durationMs: 4321,
    ts: "2026-07-26T10:00:00.000Z",
    ...overrides,
  };
}

function makeLegacySubmitLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    siteId: "ats-c",
    requestId: "req-legacy-789",
    inboundPayload: { jobId: "11111111111" },
    status: "submitted",
    auditPayload: null,
    errorMessage: null,
    durationMs: 1500,
    ts: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeBeaconLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "beacon",
    requestId: "req-abc-123",
    siteId: "ats-c",
    vivclid: "v-9981",
    jobReference: "56793094457_jid-1",
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

describe("parseReconciliationLines", () => {
  it("parses a submit line and a beacon line into two records", () => {
    const content = ndjson(makeSubmitLine(), makeBeaconLine());
    const records = parseReconciliationLines(content);
    expect(records).toHaveLength(2);
    expect(records[0]?.kind).toBe("submit");
    expect(records[1]?.kind).toBe("beacon");
  });

  it("parses a legacy line with no kind field, defaulting vivclid/jobReference to null", () => {
    const content = ndjson(makeLegacySubmitLine());
    const records = parseReconciliationLines(content);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.kind).toBe("submit");
    if (record?.kind === "submit") {
      expect(record.vivclid).toBeNull();
      expect(record.jobReference).toBeNull();
      expect(record.requestId).toBe("req-legacy-789");
    }
  });

  it("skips a truncated/malformed JSON line without aborting the read", () => {
    const content = `${JSON.stringify(makeSubmitLine())}\n{"siteId": "ats-c", "requestId": "req-tor\n${JSON.stringify(
      makeBeaconLine()
    )}\n`;
    const records = parseReconciliationLines(content);
    expect(records).toHaveLength(2);
    expect(records[0]?.kind).toBe("submit");
    expect(records[1]?.kind).toBe("beacon");
  });

  it("skips a line that parses as JSON but fails schema validation", () => {
    const content = ndjson({ kind: "submit", siteId: "ats-c" }, makeSubmitLine());
    const records = parseReconciliationLines(content);
    expect(records).toHaveLength(1);
    expect(records[0]?.requestId).toBe("req-abc-123");
  });

  it("skips blank lines", () => {
    const content = `${JSON.stringify(makeSubmitLine())}\n\n\n`;
    const records = parseReconciliationLines(content);
    expect(records).toHaveLength(1);
  });

  it("returns an empty array for empty content", () => {
    expect(parseReconciliationLines("")).toEqual([]);
  });
});

describe("foldReconciliationRecords", () => {
  it("folds a submit line and its matching beacon line into one row with beaconStatus fired", () => {
    const records = parseReconciliationLines(ndjson(makeSubmitLine(), makeBeaconLine()));
    const rows = foldReconciliationRecords(records);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestId).toBe("req-abc-123");
    expect(rows[0]?.beaconStatus).toBe("fired");
    expect(rows[0]?.beaconTrackingUrl).toBe("https://track.appcast.io/pixel?rid=req-abc-123");
    expect(rows[0]?.status).toBe("submitted");
  });

  it("yields beaconStatus not_fired for a submit line with no beacon", () => {
    const records = parseReconciliationLines(ndjson(makeSubmitLine()));
    const rows = foldReconciliationRecords(records);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.beaconStatus).toBe("not_fired");
    expect(rows[0]?.beaconTrackingUrl).toBeNull();
  });

  it("does not synthesize a phantom row for an orphan beacon with no matching submit", () => {
    const records = parseReconciliationLines(
      ndjson(makeBeaconLine({ requestId: "req-no-submit" }))
    );
    const rows = foldReconciliationRecords(records);
    expect(rows).toHaveLength(0);
  });

  it("keeps a legacy line with no kind as a first-class row with null vivclid/jobReference", () => {
    const records = parseReconciliationLines(ndjson(makeLegacySubmitLine()));
    const rows = foldReconciliationRecords(records);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.vivclid).toBeNull();
    expect(rows[0]?.jobReference).toBeNull();
    expect(rows[0]?.beaconStatus).toBe("not_fired");
  });

  it("folds multiple independent runs into separate rows keyed by requestId", () => {
    const records = parseReconciliationLines(
      ndjson(
        makeSubmitLine({ requestId: "req-1" }),
        makeSubmitLine({ requestId: "req-2" }),
        makeBeaconLine({ requestId: "req-1", beaconStatus: "fired" })
      )
    );
    const rows = foldReconciliationRecords(records);
    expect(rows).toHaveLength(2);
    const row1 = rows.find((r) => r.requestId === "req-1");
    const row2 = rows.find((r) => r.requestId === "req-2");
    expect(row1?.beaconStatus).toBe("fired");
    expect(row2?.beaconStatus).toBe("not_fired");
  });

  it("records a failed beacon distinctly from not_fired", () => {
    const records = parseReconciliationLines(
      ndjson(makeSubmitLine(), makeBeaconLine({ beaconStatus: "failed", trackingUrl: null }))
    );
    const rows = foldReconciliationRecords(records);
    expect(rows[0]?.beaconStatus).toBe("failed");
    expect(rows[0]?.beaconTrackingUrl).toBeNull();
  });
});

describe("readReconciliationRows", () => {
  let tmpDir: string;
  let sinkPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "submission-reader-test-"));
    sinkPath = path.join(tmpDir, "submissions.ndjson");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns an empty array when the sink file does not exist", async () => {
    const rows = await readReconciliationRows({ sinkPath });
    expect(rows).toEqual([]);
  });

  it("reads and folds a real sink file end to end", async () => {
    fs.writeFileSync(sinkPath, ndjson(makeSubmitLine(), makeBeaconLine()), "utf8");
    const rows = await readReconciliationRows({ sinkPath });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestId).toBe("req-abc-123");
    expect(rows[0]?.beaconStatus).toBe("fired");
  });

  it("tolerates a torn final line from a concurrent append", async () => {
    const good = ndjson(makeSubmitLine());
    fs.writeFileSync(sinkPath, `${good}{"siteId": "ats-c", "requestId": "req-torn`, "utf8");
    const rows = await readReconciliationRows({ sinkPath });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestId).toBe("req-abc-123");
  });
});
