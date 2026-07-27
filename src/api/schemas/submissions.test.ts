import { describe, expect, it } from "vitest";

import {
  type ReconciliationRow,
  reconciliationRowSchema,
  SUBMISSIONS_QUERY_LIMIT_MAX,
  submissionsQuerystringSchema,
  submissionsResponseSchema,
} from "@/api/schemas/submissions";
import { beaconEventSchema } from "@/lib/telemetry/reconciliation-record";

const EXPECTED_BEACON_STATUS_OPTIONS = [
  ...beaconEventSchema.shape.beaconStatus.options,
  "not_fired",
];

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeValidRow(): ReconciliationRow {
  return {
    siteId: "hca",
    requestId: "req-abc-001",
    joinKeys: { vivclid: "viv-123", jobReference: "emp1_jid1" },
    status: "submitted",
    errorMessage: null,
    durationMs: 842,
    ts: "2026-07-14T10:00:00.000Z",
    beaconStatus: "fired",
    trackingUrl: "https://track.example/beacon?vivclid=viv-123",
  };
}

// ── submissionsQuerystringSchema ─────────────────────────────────────────────

describe("submissionsQuerystringSchema", () => {
  it("accepts every field present as an empty string", () => {
    const result = submissionsQuerystringSchema.safeParse({
      siteId: "",
      status: "",
      beaconStatus: "",
      from: "",
      to: "",
      limit: "",
      offset: "",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a fully empty object — every field is optional", () => {
    const result = submissionsQuerystringSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("coerces limit and offset from query-string values to integers", () => {
    const result = submissionsQuerystringSchema.parse({ limit: "50", offset: "20" });
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(20);
    expect(typeof result.limit).toBe("number");
    expect(typeof result.offset).toBe("number");
  });

  it("defaults limit and offset when omitted", () => {
    const result = submissionsQuerystringSchema.parse({});
    expect(result.limit).toBe(100);
    expect(result.offset).toBe(0);
  });

  it("rejects a limit above the documented cap", () => {
    const result = submissionsQuerystringSchema.safeParse({
      limit: String(SUBMISSIONS_QUERY_LIMIT_MAX + 1),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a limit exactly at the documented cap", () => {
    const result = submissionsQuerystringSchema.safeParse({
      limit: String(SUBMISSIONS_QUERY_LIMIT_MAX),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-ISO from", () => {
    const result = submissionsQuerystringSchema.safeParse({ from: "not-a-date" });
    expect(result.success).toBe(false);
  });

  it("rejects a date-only from (no time component)", () => {
    const result = submissionsQuerystringSchema.safeParse({ from: "2026-07-14" });
    expect(result.success).toBe(false);
  });

  it("accepts a valid ISO from and to", () => {
    const result = submissionsQuerystringSchema.safeParse({
      from: "2026-07-14T00:00:00.000Z",
      to: "2026-07-26T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid status filter value", () => {
    const result = submissionsQuerystringSchema.safeParse({ status: "submitted" });
    expect(result.success).toBe(true);
  });

  it("rejects a status filter value outside the submit-status enum", () => {
    const result = submissionsQuerystringSchema.safeParse({ status: "bogus" });
    expect(result.success).toBe(false);
  });

  it("accepts exactly the beaconEventSchema options plus the not_fired fold value", () => {
    for (const value of EXPECTED_BEACON_STATUS_OPTIONS) {
      const result = submissionsQuerystringSchema.safeParse({ beaconStatus: value });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unrecognized beaconStatus value", () => {
    const result = submissionsQuerystringSchema.safeParse({ beaconStatus: "bogus" });
    expect(result.success).toBe(false);
  });

  it("accepts a requestId filter", () => {
    const result = submissionsQuerystringSchema.safeParse({ requestId: "req-abc-001" });
    expect(result.success).toBe(true);
  });

  it("normalizes a blank requestId to undefined", () => {
    const result = submissionsQuerystringSchema.parse({ requestId: "" });
    expect(result.requestId).toBeUndefined();
  });

  it("rejects a negative offset", () => {
    const result = submissionsQuerystringSchema.safeParse({ offset: "-1" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer limit", () => {
    const result = submissionsQuerystringSchema.safeParse({ limit: "1.5" });
    expect(result.success).toBe(false);
  });
});

// ── reconciliationRowSchema ───────────────────────────────────────────────────

describe("reconciliationRowSchema", () => {
  it("parses a valid row", () => {
    const result = reconciliationRowSchema.safeParse(makeValidRow());
    expect(result.success).toBe(true);
  });

  it("accepts a not_fired beaconStatus for a submit with no matching beacon", () => {
    const result = reconciliationRowSchema.safeParse({
      ...makeValidRow(),
      beaconStatus: "not_fired",
      trackingUrl: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a null joinKeys bag for a legacy unkinded record", () => {
    const result = reconciliationRowSchema.safeParse({
      ...makeValidRow(),
      joinKeys: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a row missing requestId", () => {
    const { requestId: _omit, ...incomplete } = makeValidRow();
    const result = reconciliationRowSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  it("rejects a row with an invalid beaconStatus", () => {
    const result = reconciliationRowSchema.safeParse({ ...makeValidRow(), beaconStatus: "bogus" });
    expect(result.success).toBe(false);
  });

  it("accepts exactly the beaconEventSchema options plus the not_fired fold value", () => {
    for (const value of EXPECTED_BEACON_STATUS_OPTIONS) {
      const result = reconciliationRowSchema.safeParse({ ...makeValidRow(), beaconStatus: value });
      expect(result.success).toBe(true);
    }
  });

  it("does not carry inboundPayload/auditPayload — the opaque blob is excluded", () => {
    const row = reconciliationRowSchema.parse(makeValidRow());
    expect(row).not.toHaveProperty("inboundPayload");
    expect(row).not.toHaveProperty("auditPayload");
  });
});

// ── submissionsResponseSchema ─────────────────────────────────────────────────

describe("submissionsResponseSchema", () => {
  const validStatus = {
    httpStatus: "OK",
    dateTime: "2026-07-26T00:00:00.000Z",
    details: [],
  };

  it("validates an enveloped body carrying submissions[] and total", () => {
    const result = submissionsResponseSchema.safeParse({
      status: validStatus,
      submissions: [makeValidRow()],
      total: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty submissions array with total 0", () => {
    const result = submissionsResponseSchema.safeParse({
      status: validStatus,
      submissions: [],
      total: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a response missing total", () => {
    const result = submissionsResponseSchema.safeParse({
      status: validStatus,
      submissions: [makeValidRow()],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a response with a malformed row", () => {
    const { requestId: _omit, ...malformedRow } = makeValidRow();
    const result = submissionsResponseSchema.safeParse({
      status: validStatus,
      submissions: [malformedRow],
      total: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a response missing the status envelope", () => {
    const result = submissionsResponseSchema.safeParse({
      submissions: [makeValidRow()],
      total: 1,
    });
    expect(result.success).toBe(false);
  });
});
