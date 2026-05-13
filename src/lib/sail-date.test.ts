import { describe, expect, it } from "vitest";

import { parseSailDateUtc, sailDateToNumeric } from "@/lib/sail-date";

describe("lib/sail-date parseSailDateUtc", () => {
  it("anchors YYYY-MM-DD to UTC midnight regardless of process TZ", () => {
    const d = parseSailDateUtc("2025-06-20");
    expect(d.toISOString()).toBe("2025-06-20T00:00:00.000Z");
    expect(d.getUTCDate()).toBe(20);
    expect(d.getUTCMonth()).toBe(5);
    expect(d.getUTCFullYear()).toBe(2025);
  });

  it("round-trips stably through toISOString().slice(0, 10)", () => {
    // This is the exact read pattern used by the delta endpoints to
    // emit numeric sailDates. Anchoring at UTC keeps the slice stable
    // — a local-midnight anchor would slip a day east of UTC.
    const d = parseSailDateUtc("2025-01-01");
    expect(d.toISOString().slice(0, 10)).toBe("2025-01-01");
  });

  it("handles year boundary and leap day correctly", () => {
    // Guards against any off-by-one on edge cases — leap day is the
    // one most likely to expose a subtle Date constructor bug.
    expect(parseSailDateUtc("2024-02-29").toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(parseSailDateUtc("2024-12-31").toISOString()).toBe("2024-12-31T00:00:00.000Z");
    expect(parseSailDateUtc("2025-01-01").toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });
});

describe("lib/sail-date sailDateToNumeric", () => {
  it("converts a UTC-anchored Date into YYYYMMDD", () => {
    expect(sailDateToNumeric(parseSailDateUtc("2025-06-20"))).toBe(20250620);
    expect(sailDateToNumeric(parseSailDateUtc("2026-01-01"))).toBe(20260101);
  });

  it("round-trips through parseSailDateUtc stably", () => {
    // The delta endpoint write/read pair uses both helpers; this
    // asserts they compose into a stable round-trip.
    const original = "2025-12-31";
    const stored = parseSailDateUtc(original);
    const numeric = sailDateToNumeric(stored);
    expect(numeric).toBe(20251231);
  });
});
