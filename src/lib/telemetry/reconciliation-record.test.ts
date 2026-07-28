/**
 * Zod parse/reject assertions for the reconciliation record schemas. Pure
 * schema tests — no writer or reader imports this module yet (feat-002).
 */

import { describe, expect, it } from "vitest";

import {
  beaconEventSchema,
  reconciliationRecordSchema,
  submitRecordSchema,
} from "@/lib/telemetry/reconciliation-record";

function makeSubmitLine(): Record<string, unknown> {
  return {
    kind: "submit",
    siteId: "ats-c",
    requestId: "req-abc-123",
    joinKeys: { vivclid: "v-9981", jobReference: "56793094457_jid-1" },
    inboundPayload: { jobId: "56793094457", ClickUrl: "https://example.com/apply" },
    status: "submitted",
    auditPayload: { verified: true, applicationId: "app-xyz" },
    errorMessage: null,
    durationMs: 4321,
    ts: "2026-07-26T10:00:00.000Z",
  };
}

function makeSubmitLineWithSession(): Record<string, unknown> {
  return {
    ...makeSubmitLine(),
    session: {
      id: "sess-abc",
      provider: "browserbase",
      ip: "203.0.113.42",
      ipCapturedAt: "2026-07-26T10:00:01.000Z",
    },
  };
}

function makeLegacySubmitLine(): Record<string, unknown> {
  return {
    siteId: "ats-c",
    requestId: "req-legacy-789",
    inboundPayload: { jobId: "11111111111" },
    status: "submitted",
    auditPayload: null,
    errorMessage: null,
    durationMs: 1500,
    ts: "2026-01-01T00:00:00.000Z",
  };
}

function makeLegacyVivclidSubmitLine(): Record<string, unknown> {
  return {
    siteId: "appcast",
    requestId: "req-legacy-vivclid-1",
    vivclid: "v-legacy-1",
    jobReference: "emp1_jid1",
    inboundPayload: { jobId: "22222222222" },
    status: "submitted",
    auditPayload: null,
    errorMessage: null,
    durationMs: 1800,
    ts: "2026-07-26T21:00:00.000Z",
  };
}

function makeLegacyVivclidBeaconLine(): Record<string, unknown> {
  return {
    kind: "beacon",
    requestId: "req-legacy-vivclid-beacon-1",
    siteId: "appcast",
    vivclid: "v-legacy-beacon-1",
    jobReference: "emp9_jid9",
    beaconStatus: "fired",
    trackingUrl: "https://track.appcast.io/pixel?rid=req-legacy-vivclid-beacon-1",
    durationMs: 50,
    ts: "2026-07-26T21:30:00.000Z",
  };
}

function makeBeaconLine(): Record<string, unknown> {
  return {
    kind: "beacon",
    requestId: "req-abc-123",
    siteId: "ats-c",
    joinKeys: { vivclid: "v-9981", jobReference: "56793094457_jid-1" },
    beaconStatus: "fired",
    trackingUrl: "https://track.appcast.io/pixel?rid=req-abc-123",
    durationMs: 87,
    ts: "2026-07-26T10:00:05.000Z",
  };
}

describe("submitRecordSchema", () => {
  it("accepts a record with an opaque joinKeys bag", () => {
    const result = submitRecordSchema.safeParse(makeSubmitLine());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.joinKeys).toEqual({
        vivclid: "v-9981",
        jobReference: "56793094457_jid-1",
      });
      expect(result.data.kind).toBe("submit");
    }
  });

  it("parses a pre-existing line with no kind and no joinKeys, defaulting them", () => {
    const result = submitRecordSchema.safeParse(makeLegacySubmitLine());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("submit");
      expect(result.data.joinKeys).toBeNull();
      expect(result.data.siteId).toBe("ats-c");
      expect(result.data.requestId).toBe("req-legacy-789");
      expect(result.data.session).toBeNull();
    }
  });

  it("defaults session to null when the key is absent", () => {
    const result = submitRecordSchema.safeParse(makeSubmitLine());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.session).toBeNull();
    }
  });

  it("accepts a record carrying a populated session block", () => {
    const result = submitRecordSchema.safeParse(makeSubmitLineWithSession());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.session).toEqual({
        id: "sess-abc",
        provider: "browserbase",
        ip: "203.0.113.42",
        ipCapturedAt: "2026-07-26T10:00:01.000Z",
      });
    }
  });

  it("accepts a session block with a populated id/provider but null ip/ipCapturedAt", () => {
    const result = submitRecordSchema.safeParse({
      ...makeSubmitLine(),
      session: { id: "sess-steel", provider: "steel", ip: null, ipCapturedAt: null },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.session).toEqual({
        id: "sess-steel",
        provider: "steel",
        ip: null,
        ipCapturedAt: null,
      });
    }
  });

  it("rejects a record missing a required existing field", () => {
    const { siteId: _siteId, ...withoutSiteId } = makeSubmitLine();
    const result = submitRecordSchema.safeParse(withoutSiteId);
    expect(result.success).toBe(false);
  });

  it("rejects kind values other than submit", () => {
    const result = submitRecordSchema.safeParse({ ...makeSubmitLine(), kind: "beacon" });
    expect(result.success).toBe(false);
  });
});

describe("beaconEventSchema", () => {
  it("accepts a well-formed beacon-fired event", () => {
    const result = beaconEventSchema.safeParse(makeBeaconLine());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.beaconStatus).toBe("fired");
      expect(result.data.trackingUrl).toBe("https://track.appcast.io/pixel?rid=req-abc-123");
    }
  });

  it("accepts a beacon-failed event with null trackingUrl", () => {
    const result = beaconEventSchema.safeParse({
      ...makeBeaconLine(),
      beaconStatus: "failed",
      trackingUrl: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a beacon-skipped event with null trackingUrl", () => {
    const result = beaconEventSchema.safeParse({
      ...makeBeaconLine(),
      beaconStatus: "skipped",
      trackingUrl: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.beaconStatus).toBe("skipped");
    }
  });

  it("accepts a null joinKeys bag", () => {
    const result = beaconEventSchema.safeParse({
      ...makeBeaconLine(),
      joinKeys: null,
    });
    expect(result.success).toBe(true);
  });

  it("defaults sessionIp to null when the key is absent", () => {
    const result = beaconEventSchema.safeParse(makeBeaconLine());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionIp).toBeNull();
    }
  });

  it("accepts a record carrying sessionIp", () => {
    const result = beaconEventSchema.safeParse({
      ...makeBeaconLine(),
      sessionIp: "203.0.113.42",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionIp).toBe("203.0.113.42");
    }
  });

  it("rejects a record missing the kind discriminator", () => {
    const { kind: _kind, ...withoutKind } = makeBeaconLine();
    const result = beaconEventSchema.safeParse(withoutKind);
    expect(result.success).toBe(false);
  });

  it("rejects an invalid beaconStatus value", () => {
    const result = beaconEventSchema.safeParse({ ...makeBeaconLine(), beaconStatus: "pending" });
    expect(result.success).toBe(false);
  });
});

describe("reconciliationRecordSchema", () => {
  it("routes a submit-kind line to the submit member", () => {
    const result = reconciliationRecordSchema.safeParse(makeSubmitLine());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("submit");
    }
  });

  it("routes a beacon-kind line to the beacon member", () => {
    const result = reconciliationRecordSchema.safeParse(makeBeaconLine());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("beacon");
      if (result.data.kind === "beacon") {
        expect(result.data.beaconStatus).toBe("fired");
      }
    }
  });

  it("routes a beacon-skipped line to the beacon member", () => {
    const result = reconciliationRecordSchema.safeParse({
      ...makeBeaconLine(),
      beaconStatus: "skipped",
      trackingUrl: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("beacon");
      if (result.data.kind === "beacon") {
        expect(result.data.beaconStatus).toBe("skipped");
      }
    }
  });

  it("routes a legacy line with no kind field to the submit member without throwing", () => {
    const result = reconciliationRecordSchema.safeParse(makeLegacySubmitLine());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("submit");
      expect(result.data.joinKeys).toBeNull();
    }
  });

  it("folds a pre-migration line's top-level vivclid/jobReference into joinKeys", () => {
    const result = reconciliationRecordSchema.safeParse(makeLegacyVivclidSubmitLine());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("submit");
      expect(result.data.joinKeys).toEqual({ vivclid: "v-legacy-1", jobReference: "emp1_jid1" });
      expect(result.data).not.toHaveProperty("vivclid");
      expect(result.data).not.toHaveProperty("jobReference");
    }
  });

  it("leaves a current-shape line's joinKeys untouched even if legacy fields are also present", () => {
    const result = reconciliationRecordSchema.safeParse({
      ...makeSubmitLine(),
      vivclid: "should-be-ignored",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.joinKeys).toEqual({
        vivclid: "v-9981",
        jobReference: "56793094457_jid-1",
      });
    }
  });

  it("folds a pre-migration beacon line's top-level vivclid/jobReference into joinKeys", () => {
    const result = reconciliationRecordSchema.safeParse(makeLegacyVivclidBeaconLine());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("beacon");
      expect(result.data.joinKeys).toEqual({
        vivclid: "v-legacy-beacon-1",
        jobReference: "emp9_jid9",
      });
      expect(result.data).not.toHaveProperty("vivclid");
      expect(result.data).not.toHaveProperty("jobReference");
    }
  });

  it("routes a submit line carrying a session block to the submit member and round-trips it", () => {
    const result = reconciliationRecordSchema.safeParse(makeSubmitLineWithSession());
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "submit") {
      expect(result.data.session).toEqual({
        id: "sess-abc",
        provider: "browserbase",
        ip: "203.0.113.42",
        ipCapturedAt: "2026-07-26T10:00:01.000Z",
      });
    }
  });

  it("routes a beacon line carrying sessionIp to the beacon member and round-trips it", () => {
    const result = reconciliationRecordSchema.safeParse({
      ...makeBeaconLine(),
      sessionIp: "203.0.113.42",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "beacon") {
      expect(result.data.sessionIp).toBe("203.0.113.42");
    }
  });

  it("folds legacy vivclid/jobReference into joinKeys on a submit line that also carries a session block", () => {
    const result = reconciliationRecordSchema.safeParse({
      ...makeLegacyVivclidSubmitLine(),
      session: { id: "sess-legacy", provider: "browserbase", ip: null, ipCapturedAt: null },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "submit") {
      expect(result.data.joinKeys).toEqual({ vivclid: "v-legacy-1", jobReference: "emp1_jid1" });
      expect(result.data.session).toEqual({
        id: "sess-legacy",
        provider: "browserbase",
        ip: null,
        ipCapturedAt: null,
      });
    }
  });

  it("rejects a line with an unrecognized kind", () => {
    const result = reconciliationRecordSchema.safeParse({
      ...makeSubmitLine(),
      kind: "something-else",
    });
    expect(result.success).toBe(false);
  });
});
