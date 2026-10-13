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

  it("matches a plain element of a self-describing array by value, not by slot", () => {
    const x = { filters: ["in-stock", "red;facetId=color"] };
    const y = { filters: ["red;facetId=color", "NIGHT;facetType=night", "in-stock"] };
    expect(readComparableBodyLeaf(x, y, ["filters", "0"])).toBe("in-stock");
    expect(readComparableBodyLeaf(x, { filters: ["red;facetId=color"] }, ["filters", "0"])).toBe(
      undefined
    );
  });

  it("matches the identity carried by a field of an object element", () => {
    const x = { facets: [{ token: "red;facetId=color" }, { token: "XL;facetType=size" }] };
    const y = { facets: [{ token: "M;facetType=size" }, { token: "red;facetId=color" }] };
    expect(readComparableBodyLeaf(x, y, ["facets", "0", "token"])).toBe("red;facetId=color");
    expect(readComparableBodyLeaf(x, y, ["facets", "1", "token"])).toBe("M;facetType=size");
    expect(readComparableBodyLeaf(x, { facets: [] }, ["facets", "0", "token"])).toBe(undefined);
  });

  it("pairs a duplicated identity only by exact value", () => {
    const x = { filters: ["a;tag=x", "b;tag=x", "red;facetId=color"] };
    const y = { filters: ["c;tag=x", "d;tag=x", "red;facetId=color"] };
    expect(readComparableBodyLeaf(x, y, ["filters", "0"])).toBe(undefined);
    expect(readComparableBodyLeaf(x, { filters: ["b;tag=x", "q;z=1"] }, ["filters", "0"])).toBe(
      undefined
    );
    expect(readComparableBodyLeaf(x, { filters: ["b;tag=x", "q;z=1"] }, ["filters", "1"])).toBe(
      "b;tag=x"
    );
  });
});
