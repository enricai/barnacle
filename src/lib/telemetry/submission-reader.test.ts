/**
 * Unit tests for the submissions-sink reader/fold. Pure-function tests run
 * against fixture NDJSON strings with no I/O; the `readReconciliationRows`
 * tests write to a temp directory so no real `.barnacle/` directory is
 * touched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isWithinInterval, parseISO } from "date-fns";
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
  type ReconciliationRow,
  readReconciliationRows,
} from "@/lib/telemetry/submission-reader";

function makeSubmitLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "submit",
    siteId: "ats-c",
    requestId: "req-abc-123",
    joinKeys: { clickId: "v-9981", refId: "56793094457_jid-1" },
    session: null,
    inboundPayload: { jobId: "56793094457", ClickUrl: "https://example.com/apply" },
    status: "submitted",
    auditPayload: { verified: true, applicationId: "app-xyz" },
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

describe("parseReconciliationLines", () => {
  it("parses a submit line and a beacon line into two records", () => {
    const content = ndjson(makeSubmitLine(), makeBeaconLine());
    const records = parseReconciliationLines(content);
    expect(records).toHaveLength(2);
    expect(records[0]?.kind).toBe("submit");
    expect(records[1]?.kind).toBe("beacon");
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
    expect(rows[0]?.beaconTrackingUrl).toBe("https://track.example.com/pixel?rid=req-abc-123");
    expect(rows[0]?.status).toBe("submitted");
  });

  it("yields beaconStatus not_fired for a submit line with no beacon", () => {
    const records = parseReconciliationLines(ndjson(makeSubmitLine()));
    const rows = foldReconciliationRecords(records);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.beaconStatus).toBe("not_fired");
    expect(rows[0]?.beaconTrackingUrl).toBeNull();
    expect(rows[0]?.beaconSessionIp).toBeNull();
  });

  it("folds a submit line's session block and a beacon line's sessionIp onto one row, distinct fields", () => {
    const records = parseReconciliationLines(
      ndjson(
        makeSubmitLine({
          session: {
            id: "bb-session-abc",
            provider: "browserbase",
            ip: "203.0.113.9",
            ipCapturedAt: "2026-07-26T10:00:01.000Z",
          },
        }),
        makeBeaconLine({ sessionIp: "198.51.100.42" })
      )
    );
    const rows = foldReconciliationRecords(records);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session?.ip).toBe("203.0.113.9");
    expect(rows[0]?.beaconSessionIp).toBe("198.51.100.42");
    expect(rows[0]?.beaconSessionIp).not.toBe(rows[0]?.session?.ip);
  });

  it("carries a submit line's full session block onto its row unchanged", () => {
    const session = {
      id: "bb-session-abc",
      provider: "browserbase",
      ip: "203.0.113.9",
      ipCapturedAt: "2026-07-26T10:00:01.000Z",
    };
    const records = parseReconciliationLines(ndjson(makeSubmitLine({ session })));
    const rows = foldReconciliationRecords(records);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session).toEqual(session);
  });

  it("keeps the submit row's session unchanged when a real beacon outcome outranks a skipped line, order-independent", () => {
    const session = {
      id: "bb-session-xyz",
      provider: "browserbase",
      ip: "203.0.113.50",
      ipCapturedAt: "2026-07-26T10:00:01.000Z",
    };
    const skipped = makeBeaconLine({
      beaconStatus: "skipped",
      trackingUrl: null,
      sessionIp: "198.51.100.1",
    });
    const fired = makeBeaconLine({
      beaconStatus: "fired",
      trackingUrl: "https://track.example.com/pixel?rid=req-abc-123",
      sessionIp: "198.51.100.2",
    });

    const skippedFirst = foldReconciliationRecords(
      parseReconciliationLines(ndjson(makeSubmitLine({ session }), skipped, fired))
    );
    const firedFirst = foldReconciliationRecords(
      parseReconciliationLines(ndjson(makeSubmitLine({ session }), fired, skipped))
    );

    for (const rows of [skippedFirst, firedFirst]) {
      expect(rows).toHaveLength(1);
      expect(rows[0]?.beaconStatus).toBe("fired");
      expect(rows[0]?.session).toEqual(session);
      expect(rows[0]?.beaconSessionIp).toBe("198.51.100.2");
    }
  });

  it("does not synthesize a phantom row for an orphan beacon with no matching submit", () => {
    const records = parseReconciliationLines(
      ndjson(makeBeaconLine({ requestId: "req-no-submit" }))
    );
    const rows = foldReconciliationRecords(records);
    expect(rows).toHaveLength(0);
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

  it("folds skipped-then-fired to fired, taking the fired line's fields", () => {
    const skipped = makeBeaconLine({
      beaconStatus: "skipped",
      trackingUrl: null,
      durationMs: 0,
      ts: "2026-07-26T10:00:03.000Z",
    });
    const fired = makeBeaconLine({
      beaconStatus: "fired",
      trackingUrl: "https://track.example.com/pixel?rid=req-abc-123",
      durationMs: 42,
      ts: "2026-07-26T10:00:01.000Z",
    });
    const records = parseReconciliationLines(ndjson(makeSubmitLine(), skipped, fired));
    const rows = foldReconciliationRecords(records);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.beaconStatus).toBe("fired");
    expect(rows[0]?.beaconTrackingUrl).toBe("https://track.example.com/pixel?rid=req-abc-123");
    expect(rows[0]?.beaconTs).toBe("2026-07-26T10:00:01.000Z");
    expect(rows[0]?.beaconDurationMs).toBe(42);
  });

  it("folds fired-then-skipped to the same fired row, order-independent", () => {
    const skipped = makeBeaconLine({
      beaconStatus: "skipped",
      trackingUrl: null,
      durationMs: 0,
      ts: "2026-07-26T10:00:03.000Z",
    });
    const fired = makeBeaconLine({
      beaconStatus: "fired",
      trackingUrl: "https://track.example.com/pixel?rid=req-abc-123",
      durationMs: 42,
      ts: "2026-07-26T10:00:01.000Z",
    });
    const records = parseReconciliationLines(ndjson(makeSubmitLine(), fired, skipped));
    const rows = foldReconciliationRecords(records);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.beaconStatus).toBe("fired");
    expect(rows[0]?.beaconTrackingUrl).toBe("https://track.example.com/pixel?rid=req-abc-123");
    expect(rows[0]?.beaconTs).toBe("2026-07-26T10:00:01.000Z");
    expect(rows[0]?.beaconDurationMs).toBe(42);
  });

  it("folds skipped-then-failed to failed, order-independent with failed-then-skipped", () => {
    const skipped = makeBeaconLine({
      beaconStatus: "skipped",
      trackingUrl: null,
      durationMs: 0,
      ts: "2026-07-26T10:00:03.000Z",
    });
    const failed = makeBeaconLine({
      beaconStatus: "failed",
      trackingUrl: "https://track.example.com/pixel?rid=req-abc-123",
      durationMs: 55,
      ts: "2026-07-26T10:00:01.000Z",
    });

    const skippedFirst = foldReconciliationRecords(
      parseReconciliationLines(ndjson(makeSubmitLine(), skipped, failed))
    );
    const failedFirst = foldReconciliationRecords(
      parseReconciliationLines(ndjson(makeSubmitLine(), failed, skipped))
    );

    for (const rows of [skippedFirst, failedFirst]) {
      expect(rows).toHaveLength(1);
      expect(rows[0]?.beaconStatus).toBe("failed");
      expect(rows[0]?.beaconTrackingUrl).toBe("https://track.example.com/pixel?rid=req-abc-123");
      expect(rows[0]?.beaconTs).toBe("2026-07-26T10:00:01.000Z");
      expect(rows[0]?.beaconDurationMs).toBe(55);
    }
  });

  it("keeps the later of two same-rank real outcomes (last-wins-among-real-outcomes)", () => {
    const fired = makeBeaconLine({
      beaconStatus: "fired",
      trackingUrl: "https://track.example.com/pixel?rid=req-abc-123",
      durationMs: 10,
      ts: "2026-07-26T10:00:01.000Z",
    });
    const failed = makeBeaconLine({
      beaconStatus: "failed",
      trackingUrl: null,
      durationMs: 20,
      ts: "2026-07-26T10:00:02.000Z",
    });
    const records = parseReconciliationLines(ndjson(makeSubmitLine(), fired, failed));
    const rows = foldReconciliationRecords(records);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.beaconStatus).toBe("failed");
    expect(rows[0]?.beaconTs).toBe("2026-07-26T10:00:02.000Z");
    expect(rows[0]?.beaconDurationMs).toBe(20);
  });

  it("keeps the later ts among two same-rank fired lines", () => {
    const firstFired = makeBeaconLine({
      beaconStatus: "fired",
      trackingUrl: "https://track.example.com/pixel?rid=req-abc-123&attempt=1",
      durationMs: 10,
      ts: "2026-07-26T10:00:01.000Z",
    });
    const laterFired = makeBeaconLine({
      beaconStatus: "fired",
      trackingUrl: "https://track.example.com/pixel?rid=req-abc-123&attempt=2",
      durationMs: 15,
      ts: "2026-07-26T10:00:09.000Z",
    });
    const records = parseReconciliationLines(ndjson(makeSubmitLine(), firstFired, laterFired));
    const rows = foldReconciliationRecords(records);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.beaconStatus).toBe("fired");
    expect(rows[0]?.beaconTs).toBe("2026-07-26T10:00:09.000Z");
    expect(rows[0]?.beaconTrackingUrl).toBe(
      "https://track.example.com/pixel?rid=req-abc-123&attempt=2"
    );
  });

  it("still folds a submit with only a skipped line to skipped", () => {
    const records = parseReconciliationLines(
      ndjson(makeSubmitLine(), makeBeaconLine({ beaconStatus: "skipped", trackingUrl: null }))
    );
    const rows = foldReconciliationRecords(records);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.beaconStatus).toBe("skipped");
  });

  // Provenance rule: the row's `joinKeys` is ALWAYS the submit line's bag,
  // never merged with a beacon line's — `foldReconciliationRecords` spreads
  // only `submitFields` into the row and touches nothing but
  // beaconStatus/beaconTrackingUrl/beaconTs/beaconDurationMs when a beacon
  // wins the fold. A plugin-recorded beacon line carrying additional keys
  // (e.g. `jid`) does NOT reach `GET /v1/submissions` through the row; the
  // beacon record itself still carries its own full bag through
  // `parseReconciliationLines`, it just never gets folded in.
  it("keeps the submit line's joinKeys on the folded row when the winning beacon's joinKeys is a strict superset, while the beacon record itself retains its own full bag", () => {
    const submitJoinKeys = { clickId: "v-9981" };
    const beaconJoinKeys = { clickId: "v-9981", jid: "jid-555" };
    const records = parseReconciliationLines(
      ndjson(
        makeSubmitLine({ joinKeys: submitJoinKeys }),
        makeBeaconLine({ joinKeys: beaconJoinKeys })
      )
    );

    const beaconRecord = records.find((r) => r.kind === "beacon");
    expect(beaconRecord?.kind).toBe("beacon");
    if (beaconRecord?.kind === "beacon") {
      expect(beaconRecord.joinKeys).toEqual(beaconJoinKeys);
    }

    const rows = foldReconciliationRecords(records);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.joinKeys).toEqual(submitJoinKeys);
  });

  // Provenance rule: the winning beacon line's `trackingUrl` overwrites the
  // row's `beaconTrackingUrl` verbatim, even when it is `null` and a
  // lower-ranked `skipped` line carried a real URL — `beaconRank` picks the
  // winner by status only, and the fold then takes ALL four beacon fields
  // from that one winning line rather than backfilling from a loser. This
  // means a real `fired`/`failed` outcome with no known URL nulls out a
  // `skipped` line's URL rather than inheriting it, order-independent.
  it("nulls the row's beaconTrackingUrl when the winning fired line has none, even though the losing skipped line carried a real URL", () => {
    const skipped = makeBeaconLine({
      beaconStatus: "skipped",
      trackingUrl: "https://track.example.com/pixel?rid=req-abc-123",
      durationMs: 0,
      ts: "2026-07-26T10:00:03.000Z",
    });
    const fired = makeBeaconLine({
      beaconStatus: "fired",
      trackingUrl: null,
      durationMs: 42,
      ts: "2026-07-26T10:00:05.000Z",
    });

    const skippedFirst = foldReconciliationRecords(
      parseReconciliationLines(ndjson(makeSubmitLine(), skipped, fired))
    );
    const firedFirst = foldReconciliationRecords(
      parseReconciliationLines(ndjson(makeSubmitLine(), fired, skipped))
    );

    for (const rows of [skippedFirst, firedFirst]) {
      expect(rows).toHaveLength(1);
      expect(rows[0]?.beaconStatus).toBe("fired");
      expect(rows[0]?.beaconTrackingUrl).toBeNull();
    }
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

describe("querying reconciliation rows by join key, time window, and page bound", () => {
  let tmpDir: string;
  let sinkPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "submission-reader-query-test-"));
    sinkPath = path.join(tmpDir, "submissions.ndjson");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function readFixtureRows(): Promise<ReconciliationRow[]> {
    const lines = [
      makeSubmitLine({
        requestId: "req-a",
        joinKeys: { clickId: "v-100", refId: "111_jid-1" },
        siteId: "ats-a",
        ts: "2026-07-20T09:00:00.000Z",
      }),
      makeSubmitLine({
        requestId: "req-b",
        joinKeys: { clickId: "v-200", refId: "222_jid-2" },
        siteId: "ats-b",
        ts: "2026-07-20T10:00:00.000Z",
      }),
      makeSubmitLine({
        requestId: "req-c",
        joinKeys: { clickId: "v-300", refId: "333_jid-3" },
        siteId: "ats-a",
        ts: "2026-07-20T11:00:00.000Z",
      }),
      makeSubmitLine({
        requestId: "req-d",
        joinKeys: { clickId: "v-400", refId: "444_jid-4" },
        siteId: "ats-b",
        ts: "2026-07-20T12:00:00.000Z",
      }),
      makeSubmitLine({
        requestId: "req-e",
        joinKeys: { clickId: "v-500", refId: "555_jid-5" },
        siteId: "ats-c",
        ts: "2026-07-20T13:00:00.000Z",
      }),
    ];
    fs.writeFileSync(sinkPath, ndjson(...lines), "utf8");
    return readReconciliationRows({ sinkPath });
  }

  it("resolves an exact-match clickId filter to its one row", async () => {
    const rows = await readFixtureRows();
    const matches = rows.filter((row) => row.joinKeys?.clickId === "v-300");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.requestId).toBe("req-c");
  });

  it("resolves an exact-match siteId filter to every row for that cohort", async () => {
    const rows = await readFixtureRows();
    const matches = rows.filter((row) => row.siteId === "ats-a");
    expect(matches.map((row) => row.requestId).sort()).toEqual(["req-a", "req-c"]);
  });

  it("resolves an exact-match refId filter to its one row", async () => {
    const rows = await readFixtureRows();
    const matches = rows.filter((row) => row.joinKeys?.refId === "444_jid-4");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.requestId).toBe("req-d");
  });

  it("includes both boundary rows in a ts time-window filter", async () => {
    const rows = await readFixtureRows();
    const window = {
      start: parseISO("2026-07-20T10:00:00.000Z"),
      end: parseISO("2026-07-20T12:00:00.000Z"),
    };
    const matches = rows.filter((row) => isWithinInterval(parseISO(row.ts), window));
    expect(matches.map((row) => row.requestId).sort()).toEqual(["req-b", "req-c", "req-d"]);
  });

  it("caps the rows returned to a limit/offset page", async () => {
    const rows = await readFixtureRows();
    const sortedByTs = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));
    const page = sortedByTs.slice(1, 1 + 2);
    expect(page.map((row) => row.requestId)).toEqual(["req-b", "req-c"]);
  });
});
