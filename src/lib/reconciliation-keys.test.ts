import { describe, expect, it } from "vitest";

import {
  extractJobReference,
  extractReconciliationKeys,
  extractVivclid,
} from "@/lib/reconciliation-keys";

describe("lib/reconciliation-keys extractVivclid", () => {
  it("extracts vivclid from the TrackingUrl query string", () => {
    const payload = { TrackingUrl: "https://click.acme.example/t/abc?vivclid=123" };
    expect(extractVivclid(payload)).toBe("123");
  });

  it("extracts vivclid from a top-level payload key", () => {
    expect(extractVivclid({ vivclid: "456" })).toBe("456");
  });

  it("matches the top-level payload key case-insensitively", () => {
    expect(extractVivclid({ VivClid: "789" })).toBe("789");
  });

  it("prefers the top-level payload key over the TrackingUrl query param", () => {
    const payload = {
      vivclid: "explicit",
      TrackingUrl: "https://click.acme.example/t/abc?vivclid=from-url",
    };
    expect(extractVivclid(payload)).toBe("explicit");
  });

  it("returns null when vivclid is absent from both payload and TrackingUrl", () => {
    expect(extractVivclid({ TrackingUrl: "https://click.acme.example/t/abc" })).toBeNull();
  });

  it("returns null for a malformed TrackingUrl instead of throwing", () => {
    expect(extractVivclid({ TrackingUrl: "not-a-url" })).toBeNull();
  });

  it("returns null when TrackingUrl is absent", () => {
    expect(extractVivclid({})).toBeNull();
  });

  it("returns null for a non-object payload", () => {
    expect(extractVivclid(null)).toBeNull();
    expect(extractVivclid(undefined)).toBeNull();
    expect(extractVivclid("a string")).toBeNull();
    expect(extractVivclid(42)).toBeNull();
    expect(extractVivclid(["array"])).toBeNull();
  });

  it("returns null when the payload key is present but empty", () => {
    expect(extractVivclid({ vivclid: "" })).toBeNull();
  });
});

describe("lib/reconciliation-keys extractJobReference", () => {
  it("uses the explicit jobReference field when present", () => {
    expect(extractJobReference({ jobReference: "ref-1" })).toBe("ref-1");
  });

  it("matches the explicit jobReference field case-insensitively", () => {
    expect(extractJobReference({ JobReference: "ref-2" })).toBe("ref-2");
  });

  it("composes empId_jid from top-level payload fields when jobReference is absent", () => {
    expect(extractJobReference({ empId: "emp1", jid: "job1" })).toBe("emp1_job1");
  });

  it("prefers the explicit jobReference field over empId/jid composition", () => {
    const payload = { jobReference: "explicit-ref", empId: "emp1", jid: "job1" };
    expect(extractJobReference(payload)).toBe("explicit-ref");
  });

  it("falls back to empId/jid query params on TrackingUrl", () => {
    const payload = { TrackingUrl: "https://click.acme.example/t/abc?empId=emp9&jid=job9" };
    expect(extractJobReference(payload)).toBe("emp9_job9");
  });

  it("prefers payload empId/jid over the TrackingUrl pair", () => {
    const payload = {
      empId: "emp1",
      jid: "job1",
      TrackingUrl: "https://click.acme.example/t/abc?empId=emp9&jid=job9",
    };
    expect(extractJobReference(payload)).toBe("emp1_job1");
  });

  it("returns null when only empId is present, without a jid pair", () => {
    expect(extractJobReference({ empId: "emp1" })).toBeNull();
  });

  it("returns null when only jid is present, without an empId pair", () => {
    expect(extractJobReference({ jid: "job1" })).toBeNull();
  });

  it("returns null when empId or jid is a non-string value", () => {
    expect(extractJobReference({ empId: 1, jid: "job1" })).toBeNull();
    expect(extractJobReference({ empId: "emp1", jid: 2 })).toBeNull();
  });

  it("returns null when the TrackingUrl carries only one of empId/jid", () => {
    const payload = { TrackingUrl: "https://click.acme.example/t/abc?empId=emp9" };
    expect(extractJobReference(payload)).toBeNull();
  });

  it("returns null for a malformed TrackingUrl instead of throwing", () => {
    expect(extractJobReference({ TrackingUrl: "not-a-url" })).toBeNull();
  });

  it("returns null when no candidate key resolves", () => {
    expect(extractJobReference({})).toBeNull();
  });

  it("returns null for a non-object payload", () => {
    expect(extractJobReference(null)).toBeNull();
    expect(extractJobReference(undefined)).toBeNull();
    expect(extractJobReference("a string")).toBeNull();
    expect(extractJobReference(42)).toBeNull();
  });
});

describe("lib/reconciliation-keys extractReconciliationKeys", () => {
  it("returns both keys resolved from a payload with a TrackingUrl", () => {
    const payload = {
      TrackingUrl: "https://click.acme.example/t/abc?vivclid=123&empId=emp9&jid=job9",
    };
    expect(extractReconciliationKeys(payload)).toEqual({
      vivclid: "123",
      jobReference: "emp9_job9",
    });
  });

  it("returns both keys as null when nothing resolves", () => {
    expect(extractReconciliationKeys({})).toEqual({ vivclid: null, jobReference: null });
  });

  it("never throws on a non-object payload", () => {
    expect(extractReconciliationKeys(null)).toEqual({ vivclid: null, jobReference: null });
  });
});
