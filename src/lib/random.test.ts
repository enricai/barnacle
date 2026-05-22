import { afterEach, describe, expect, it, vi } from "vitest";

import { pickRandom, randomIntInclusive } from "@/lib/random";

describe("lib/random randomIntInclusive", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns min when min === max (degenerate range)", () => {
    expect(randomIntInclusive(3, 3)).toBe(3);
  });

  it("returns 0 for the (0, 0) degenerate range", () => {
    expect(randomIntInclusive(0, 0)).toBe(0);
  });

  it("returns min when max < min (guard clause)", () => {
    expect(randomIntInclusive(10, 5)).toBe(10);
  });

  it("returns values inside [min, max] across many samples", () => {
    const min = -3;
    const max = 7;
    for (let i = 0; i < 1000; i += 1) {
      const value = randomIntInclusive(min, max);
      expect(value).toBeGreaterThanOrEqual(min);
      expect(value).toBeLessThanOrEqual(max);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("hits min when Math.random returns 0", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(randomIntInclusive(2, 5)).toBe(2);
  });

  it("hits max when Math.random returns just under 1", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9999999);
    expect(randomIntInclusive(2, 5)).toBe(5);
  });
});

describe("lib/random pickRandom", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an element from a non-empty array", () => {
    const arr = [10, 20, 30, 40];
    for (let i = 0; i < 100; i += 1) {
      expect(arr).toContain(pickRandom(arr));
    }
  });

  it("works with readonly tuples", () => {
    const tuple = ["a", "b", "c"] as const;
    const picked = pickRandom(tuple);
    expect(tuple).toContain(picked);
  });

  it("returns the only element from a single-item array", () => {
    expect(pickRandom(["only"])).toBe("only");
  });

  it("picks the first element when Math.random returns 0", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickRandom([1, 2, 3])).toBe(1);
  });

  it("picks the last element when Math.random approaches 1", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9999999);
    expect(pickRandom([1, 2, 3])).toBe(3);
  });
});
