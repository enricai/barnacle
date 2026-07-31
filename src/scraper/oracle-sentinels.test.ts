import { describe, expect, it } from "vitest";

import { classifyOracleSentinel } from "@/scraper/oracle-sentinels";

describe("classifyOracleSentinel", () => {
  describe("locked sentinels", () => {
    it("returns 'locked' for ORA_URL_LOCKED", () => {
      expect(classifyOracleSentinel("ORA_URL_LOCKED")).toBe("locked");
    });

    it("returns 'locked' for ORA_URL_LOCKED with leading whitespace", () => {
      expect(classifyOracleSentinel("  ORA_URL_LOCKED")).toBe("locked");
    });

    it("returns 'locked' for ORA_URL_LOCKED with trailing whitespace", () => {
      expect(classifyOracleSentinel("ORA_URL_LOCKED  ")).toBe("locked");
    });

    it("returns 'locked' for ORA_URL_LOCKED surrounded by whitespace", () => {
      expect(classifyOracleSentinel("  ORA_URL_LOCKED  ")).toBe("locked");
    });

    it("returns 'locked' for ORA_URL_LOCKED with trailing newline", () => {
      expect(classifyOracleSentinel("ORA_URL_LOCKED\n")).toBe("locked");
    });
  });

  describe("transient sentinels (ORA_IRC_*)", () => {
    it("returns 'transient' for ORA_IRC_TOKEN_EXPIRED", () => {
      expect(classifyOracleSentinel("ORA_IRC_TOKEN_EXPIRED")).toBe("transient");
    });

    it("returns 'transient' for ORA_IRC_* with leading whitespace", () => {
      expect(classifyOracleSentinel("  ORA_IRC_TOKEN_EXPIRED")).toBe("transient");
    });

    it("returns 'transient' for ORA_IRC_* with trailing whitespace", () => {
      expect(classifyOracleSentinel("ORA_IRC_TOKEN_EXPIRED  ")).toBe("transient");
    });

    it("returns 'transient' for any ORA_IRC_ prefixed sentinel", () => {
      expect(classifyOracleSentinel("ORA_IRC_SESSION_INVALID")).toBe("transient");
    });

    it("returns 'transient' for ORA_IRC_ minimal prefix body", () => {
      expect(classifyOracleSentinel("ORA_IRC_")).toBe("transient");
    });
  });

  describe("none — non-sentinel bodies", () => {
    it("returns 'none' for an HTML error page", () => {
      expect(classifyOracleSentinel("<!DOCTYPE html><html><body>Error</body></html>")).toBe("none");
    });

    it("returns 'none' for empty string", () => {
      expect(classifyOracleSentinel("")).toBe("none");
    });

    it("returns 'none' for whitespace-only string", () => {
      expect(classifyOracleSentinel("   ")).toBe("none");
    });

    it("returns 'none' for a random plain-text error", () => {
      expect(classifyOracleSentinel("Service Unavailable")).toBe("none");
    });

    it("returns 'none' for an unknown ORA_ token (not ORA_URL_LOCKED, not ORA_IRC_*)", () => {
      expect(classifyOracleSentinel("ORA_SOMETHING_ELSE")).toBe("none");
    });

    it("returns 'none' for a partial match that is not a sentinel (ORA_URL_ prefix only)", () => {
      expect(classifyOracleSentinel("ORA_URL_OPEN")).toBe("none");
    });

    it("returns 'none' for a token that starts with ORA_URL_LOCKED but has extra content", () => {
      expect(classifyOracleSentinel("ORA_URL_LOCKED_EXTENDED")).toBe("none");
    });

    it("returns 'none' for JSON content", () => {
      expect(classifyOracleSentinel('{"error":"not found"}')).toBe("none");
    });
  });
});
