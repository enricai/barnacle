import { describe, expect, it } from "vitest";
import { mergeFoldedPrimaryBodies } from "@/lib/merge-folded-primary-bodies";

describe("mergeFoldedPrimaryBodies", () => {
  it("concatenates array values at a colliding key instead of overwriting", () => {
    const first = { items: [{ id: 1 }], meta: { page: 1 } };
    const second = { items: [{ id: 2 }], other: "x" };

    const result = mergeFoldedPrimaryBodies(first, second);

    expect(result).toEqual({
      items: [{ id: 1 }, { id: 2 }],
      meta: { page: 1 },
      other: "x",
    });
  });

  it("preserves non-colliding top-level keys from each input untouched", () => {
    const first = { a: 1 };
    const second = { b: 2 };

    expect(mergeFoldedPrimaryBodies(first, second)).toEqual({ a: 1, b: 2 });
  });

  it("recursively merges nested plain objects, concatenating nested arrays", () => {
    const first = { nested: { items: [1, 2] } };
    const second = { nested: { items: [3], extra: true } };

    expect(mergeFoldedPrimaryBodies(first, second)).toEqual({
      nested: { items: [1, 2, 3], extra: true },
    });
  });

  it("falls back to last-write-wins for scalar collisions", () => {
    const first = { count: 1 };
    const second = { count: 2 };

    expect(mergeFoldedPrimaryBodies(first, second)).toEqual({ count: 2 });
  });

  it("merges three or more bodies left to right", () => {
    const result = mergeFoldedPrimaryBodies({ items: [1] }, { items: [2] }, { items: [3] });

    expect(result).toEqual({ items: [1, 2, 3] });
  });
});
