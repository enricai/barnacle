import { describe, expect, it } from "vitest";

import { readComparableBodyLeaf } from "@/scripts/recon-generate";

describe("readComparableBodyLeaf", () => {
  const a = { filters: ["red;facetId=color", "XL;facetType=size"] };

  it("finds the same identity in a different slot or array length", () => {
    const b = { filters: ["M;facetType=size", "x;other=y", "red;facetId=color"] };
    expect(readComparableBodyLeaf(a, b, ["filters", "0"])).toBe("red;facetId=color");
    expect(readComparableBodyLeaf(a, b, ["filters", "1"])).toBe("M;facetType=size");
  });

  it("returns undefined when the identity is absent", () => {
    expect(readComparableBodyLeaf(a, { filters: ["red;facetId=color"] }, ["filters", "1"])).toBe(
      undefined
    );
    expect(readComparableBodyLeaf(a, {}, ["filters", "0"])).toBe(undefined);
  });

  it("defers to positional reads for non-array and identity-less leaves", () => {
    const x = { sku: "A1", tags: ["red", "blue"] };
    const y = { sku: "B2", tags: ["green"] };
    expect(readComparableBodyLeaf(x, y, ["sku"])).toBe("B2");
    expect(readComparableBodyLeaf(x, y, ["tags", "0"])).toBe("green");
    expect(readComparableBodyLeaf(x, y, ["tags", "1"])).toBe(undefined);
  });

  it("still reports same identity with different values as differing", () => {
    const b = { filters: ["blue;facetId=color"] };
    expect(readComparableBodyLeaf(a, b, ["filters", "0"])).toBe("blue;facetId=color");
  });
});
