/**
 * Unit tests for `queryReconciliationRows`: pure predicate composition over
 * an in-memory `ReconciliationRow[]`, no filesystem involved.
 */

import { describe, expect, it } from "vitest";

import { queryReconciliationRows } from "@/lib/telemetry/submission-query";
import type { ReconciliationRow } from "@/lib/telemetry/submission-reader";

function makeRow(overrides: Partial<ReconciliationRow> = {}): ReconciliationRow {
  return {
    siteId: "hca",
    requestId: "req-1",
    vivclid: "viv-1",
    jobReference: "emp1_jid1",
    inboundPayload: { jobId: "jid1" },
    status: "submitted",
    auditPayload: null,
    errorMessage: null,
    durationMs: 100,
    ts: "2026-07-14T10:00:00.000Z",
    beaconStatus: "fired",
    beaconTrackingUrl: "https://track.example/beacon",
    beaconTs: "2026-07-14T10:00:05.000Z",
    beaconDurationMs: 42,
    ...overrides,
  };
}

describe("queryReconciliationRows", () => {
  it("filters by vivclid, returning only matching rows", () => {
    const rows = [
      makeRow({ requestId: "req-1", vivclid: "viv-a" }),
      makeRow({ requestId: "req-2", vivclid: "viv-b" }),
    ];
    const result = queryReconciliationRows(rows, { vivclid: "viv-a" });
    expect(result).toHaveLength(1);
    expect(result[0]?.requestId).toBe("req-1");
  });

  it("filters by siteId", () => {
    const rows = [
      makeRow({ requestId: "req-1", siteId: "hca" }),
      makeRow({ requestId: "req-2", siteId: "ats-c" }),
    ];
    const result = queryReconciliationRows(rows, { siteId: "ats-c" });
    expect(result).toHaveLength(1);
    expect(result[0]?.requestId).toBe("req-2");
  });

  it("filters by jobReference", () => {
    const rows = [
      makeRow({ requestId: "req-1", jobReference: "emp1_jid1" }),
      makeRow({ requestId: "req-2", jobReference: "emp2_jid2" }),
    ];
    const result = queryReconciliationRows(rows, { jobReference: "emp2_jid2" });
    expect(result).toHaveLength(1);
    expect(result[0]?.requestId).toBe("req-2");
  });

  it("filters by requestId", () => {
    const rows = [makeRow({ requestId: "req-1" }), makeRow({ requestId: "req-2" })];
    const result = queryReconciliationRows(rows, { requestId: "req-1" });
    expect(result).toHaveLength(1);
    expect(result[0]?.requestId).toBe("req-1");
  });

  it("filters by status", () => {
    const rows = [
      makeRow({ requestId: "req-1", status: "submitted" }),
      makeRow({ requestId: "req-2", status: "error" }),
    ];
    const result = queryReconciliationRows(rows, { status: "error" });
    expect(result).toHaveLength(1);
    expect(result[0]?.requestId).toBe("req-2");
  });

  it("filters by beaconStatus", () => {
    const rows = [
      makeRow({ requestId: "req-1", beaconStatus: "fired" }),
      makeRow({ requestId: "req-2", beaconStatus: "not_fired" }),
      makeRow({ requestId: "req-3", beaconStatus: "failed" }),
    ];
    const result = queryReconciliationRows(rows, { beaconStatus: "not_fired" });
    expect(result).toHaveLength(1);
    expect(result[0]?.requestId).toBe("req-2");
  });

  it("composes vivclid, siteId, and status filters as AND", () => {
    const rows = [
      makeRow({ requestId: "req-1", vivclid: "viv-a", siteId: "hca", status: "submitted" }),
      makeRow({ requestId: "req-2", vivclid: "viv-a", siteId: "hca", status: "error" }),
      makeRow({ requestId: "req-3", vivclid: "viv-a", siteId: "ats-c", status: "submitted" }),
    ];
    const result = queryReconciliationRows(rows, {
      vivclid: "viv-a",
      siteId: "hca",
      status: "submitted",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.requestId).toBe("req-1");
  });

  it("filters on a from/to window inclusively", () => {
    const rows = [
      makeRow({ requestId: "before", ts: "2026-07-13T00:00:00.000Z" }),
      makeRow({ requestId: "at-from", ts: "2026-07-14T00:00:00.000Z" }),
      makeRow({ requestId: "inside", ts: "2026-07-15T00:00:00.000Z" }),
      makeRow({ requestId: "at-to", ts: "2026-07-16T00:00:00.000Z" }),
      makeRow({ requestId: "after", ts: "2026-07-17T00:00:00.000Z" }),
    ];
    const result = queryReconciliationRows(rows, {
      from: "2026-07-14T00:00:00.000Z",
      to: "2026-07-16T00:00:00.000Z",
    });
    expect(result.map((row) => row.requestId).sort()).toEqual(["at-from", "at-to", "inside"]);
  });

  it("filters on from alone, with no upper bound", () => {
    const rows = [
      makeRow({ requestId: "before", ts: "2026-07-13T00:00:00.000Z" }),
      makeRow({ requestId: "after", ts: "2026-07-20T00:00:00.000Z" }),
    ];
    const result = queryReconciliationRows(rows, { from: "2026-07-14T00:00:00.000Z" });
    expect(result.map((row) => row.requestId)).toEqual(["after"]);
  });

  it("filters on to alone, with no lower bound", () => {
    const rows = [
      makeRow({ requestId: "before", ts: "2026-07-13T00:00:00.000Z" }),
      makeRow({ requestId: "after", ts: "2026-07-20T00:00:00.000Z" }),
    ];
    const result = queryReconciliationRows(rows, { to: "2026-07-14T00:00:00.000Z" });
    expect(result.map((row) => row.requestId)).toEqual(["before"]);
  });

  it("returns every row unchanged for an empty filter object", () => {
    const rows = [
      makeRow({ requestId: "req-1", ts: "2026-07-14T00:00:00.000Z" }),
      makeRow({ requestId: "req-2", ts: "2026-07-15T00:00:00.000Z" }),
    ];
    const result = queryReconciliationRows(rows, {});
    expect(result).toHaveLength(2);
    expect(new Set(result.map((row) => row.requestId))).toEqual(new Set(["req-1", "req-2"]));
  });

  it("returns every row unchanged when no filter argument is passed", () => {
    const rows = [makeRow({ requestId: "req-1" }), makeRow({ requestId: "req-2" })];
    const result = queryReconciliationRows(rows);
    expect(result).toHaveLength(2);
  });

  it("orders results newest-first by ts regardless of input order", () => {
    const rows = [
      makeRow({ requestId: "oldest", ts: "2026-07-01T00:00:00.000Z" }),
      makeRow({ requestId: "newest", ts: "2026-07-26T00:00:00.000Z" }),
      makeRow({ requestId: "middle", ts: "2026-07-14T00:00:00.000Z" }),
    ];
    const result = queryReconciliationRows(rows);
    expect(result.map((row) => row.requestId)).toEqual(["newest", "middle", "oldest"]);
  });

  it("paginates deterministically with limit and offset", () => {
    const rows = [
      makeRow({ requestId: "r1", ts: "2026-07-10T00:00:00.000Z" }),
      makeRow({ requestId: "r2", ts: "2026-07-11T00:00:00.000Z" }),
      makeRow({ requestId: "r3", ts: "2026-07-12T00:00:00.000Z" }),
      makeRow({ requestId: "r4", ts: "2026-07-13T00:00:00.000Z" }),
    ];
    const page1 = queryReconciliationRows(rows, { limit: 2, offset: 0 });
    const page2 = queryReconciliationRows(rows, { limit: 2, offset: 2 });
    expect(page1.map((row) => row.requestId)).toEqual(["r4", "r3"]);
    expect(page2.map((row) => row.requestId)).toEqual(["r2", "r1"]);
  });

  it("returns an empty array when offset exceeds the matched row count", () => {
    const rows = [makeRow({ requestId: "r1" }), makeRow({ requestId: "r2" })];
    const result = queryReconciliationRows(rows, { limit: 10, offset: 5 });
    expect(result).toEqual([]);
  });

  it("returns an empty array when filtering an empty row array", () => {
    const result = queryReconciliationRows([], { vivclid: "viv-a" });
    expect(result).toEqual([]);
  });
});
