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
    joinKeys: { clickId: "v-9981", refId: "56793094457_jid-1" },
    session: null,
    inboundPayload: { jobId: "56793094457", ClickUrl: "https://example.com/apply" },
    status: "submitted",
    auditPayload: { verified: true, applicationId: "app-xyz" },
    errorMessage: null,
    hotPathError: null,
    durationMs: 4321,
    ts: "2026-07-26T10:00:00.000Z",
  };
}

function makeSubmitLineWithHotPathError(): Record<string, unknown> {
  return {
    ...makeSubmitLine(),
    hotPathError: { name: "TimeoutError", message: "navigation timed out", code: "ETIMEDOUT" },
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

function makeBeaconLine(): Record<string, unknown> {
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
  };
}

describe("submitRecordSchema", () => {
  it("accepts a record with an opaque joinKeys bag", () => {
    const result = submitRecordSchema.safeParse(makeSubmitLine());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.joinKeys).toEqual({
        clickId: "v-9981",
        refId: "56793094457_jid-1",
      });
      expect(result.data.kind).toBe("submit");
    }
  });

  it("rejects a line with no kind field", () => {
    const { kind: _kind, ...withoutKind } = makeSubmitLine();
    const result = submitRecordSchema.safeParse(withoutKind);
    expect(result.success).toBe(false);
  });

  it("rejects a line with no joinKeys field", () => {
    const { joinKeys: _joinKeys, ...withoutJoinKeys } = makeSubmitLine();
    const result = submitRecordSchema.safeParse(withoutJoinKeys);
    expect(result.success).toBe(false);
  });

  it("rejects a line with no session field", () => {
    const { session: _session, ...withoutSession } = makeSubmitLine();
    const result = submitRecordSchema.safeParse(withoutSession);
    expect(result.success).toBe(false);
  });

  it("accepts a null session", () => {
    const result = submitRecordSchema.safeParse({ ...makeSubmitLine(), session: null });
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

  it("accepts a line with hotPathError omitted", () => {
    const { hotPathError: _hotPathError, ...withoutHotPathError } = makeSubmitLine();
    const result = submitRecordSchema.safeParse(withoutHotPathError);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hotPathError).toBeUndefined();
    }
  });

  it("accepts a null hotPathError", () => {
    const result = submitRecordSchema.safeParse({ ...makeSubmitLine(), hotPathError: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hotPathError).toBeNull();
    }
  });

  it("accepts a record carrying a populated hotPathError block", () => {
    const result = submitRecordSchema.safeParse(makeSubmitLineWithHotPathError());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hotPathError).toEqual({
        name: "TimeoutError",
        message: "navigation timed out",
        code: "ETIMEDOUT",
      });
    }
  });

  it("accepts a hotPathError block with a null code", () => {
    const result = submitRecordSchema.safeParse({
      ...makeSubmitLine(),
      hotPathError: { name: "ScraperError", message: "site rejected the submission", code: null },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hotPathError).toEqual({
        name: "ScraperError",
        message: "site rejected the submission",
        code: null,
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
      expect(result.data.trackingUrl).toBe("https://track.example.com/pixel?rid=req-abc-123");
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

  it("rejects a line with no sessionIp field", () => {
    const { sessionIp: _sessionIp, ...withoutSessionIp } = makeBeaconLine();
    const result = beaconEventSchema.safeParse(withoutSessionIp);
    expect(result.success).toBe(false);
  });

  it("accepts a null sessionIp", () => {
    const result = beaconEventSchema.safeParse({ ...makeBeaconLine(), sessionIp: null });
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

  it("rejects a line with no kind field", () => {
    const { kind: _kind, ...withoutKind } = makeSubmitLine();
    const result = reconciliationRecordSchema.safeParse(withoutKind);
    expect(result.success).toBe(false);
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

  it("rejects a line with an unrecognized kind", () => {
    const result = reconciliationRecordSchema.safeParse({
      ...makeSubmitLine(),
      kind: "something-else",
    });
    expect(result.success).toBe(false);
  });
});
