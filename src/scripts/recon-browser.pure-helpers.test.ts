import { describe, expect, it, vi } from "vitest";
import {
  detectRejectionInResponseBody,
  isStructurallyBlocked,
  resolveGotoWaitUntil,
} from "@/scripts/recon-browser";

describe("resolveGotoWaitUntil", () => {
  const log = () => ({ warn: vi.fn() }) as never;
  it("defaults when unset/blank", () => {
    expect(resolveGotoWaitUntil(undefined, log())).toBe("domcontentloaded");
    expect(resolveGotoWaitUntil("  ", log())).toBe("domcontentloaded");
  });
  it("accepts valid load states", () => {
    expect(resolveGotoWaitUntil("load", log())).toBe("load");
    expect(resolveGotoWaitUntil(" networkidle ", log())).toBe("networkidle");
    expect(resolveGotoWaitUntil("domcontentloaded", log())).toBe("domcontentloaded");
  });
  it("warns and falls back on a typo", () => {
    const l = log();
    expect(resolveGotoWaitUntil("commit", l)).toBe("domcontentloaded");
    expect((l as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });
});

describe("detectRejectionInResponseBody", () => {
  it("ignores non-object bodies", () => {
    expect(detectRejectionInResponseBody(null)).toEqual({ rejected: false, reason: null });
    expect(detectRejectionInResponseBody("x")).toEqual({ rejected: false, reason: null });
  });
  it("detects not_qualified with and without error", () => {
    expect(detectRejectionInResponseBody({ not_qualified: true, error: "nope" })).toEqual({
      rejected: true,
      reason: "nope",
    });
    expect(detectRejectionInResponseBody({ not_qualified: true }).reason).toBe("not_qualified");
  });
  it("detects rejected flag", () => {
    expect(detectRejectionInResponseBody({ rejected: true, reason: "bad" }).reason).toBe("bad");
    expect(detectRejectionInResponseBody({ rejected: true }).reason).toBe("rejected");
  });
  it("detects qualified:false", () => {
    expect(detectRejectionInResponseBody({ qualified: false }).rejected).toBe(true);
  });
});

describe("isStructurallyBlocked", () => {
  it("is false for no attempts", () => {
    expect(isStructurallyBlocked([])).toBe(false);
  });
  it("is true only when every attempt tried nothing and verified nothing", () => {
    expect(isStructurallyBlocked([{ triedSelectors: [], verifiedBy: null }])).toBe(true);
    expect(
      isStructurallyBlocked([
        { triedSelectors: [], verifiedBy: null },
        { triedSelectors: ["a"], verifiedBy: null },
      ])
    ).toBe(false);
  });
});
