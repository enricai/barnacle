import { describe, expect, it } from "vitest";
import {
  collectRequestBodyValuesByKey,
  findFrozenVaryingDrillParams,
  readComparableBodyLeaf,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

const cap = (body: unknown): Capture =>
  ({ url: "https://x/search", method: "POST", requestPostData: JSON.stringify(body) }) as Capture;

describe("readComparableBodyLeaf array identity keying", () => {
  it("finds a moved element by identity, not by index", () => {
    const a = { filters: ["red;facetId=color", "XL;facetType=size"] };
    const b = { filters: ["XL;facetType=size", "red;facetId=color"] };
    expect(readComparableBodyLeaf(a, b, ["filters", "0"])).toBe("red;facetId=color");
    expect(readComparableBodyLeaf(a, b, ["filters", "1"])).toBe("XL;facetType=size");
  });

  it("returns the other body's value when only the identity value differs", () => {
    const a = { filters: ["red;facetId=color"] };
    const b = { filters: ["blue;facetId=color"] };
    expect(readComparableBodyLeaf(a, b, ["filters", "0"])).toBe("blue;facetId=color");
  });

  it("yields undefined for an identity the other array lacks, even in the same slot", () => {
    const a = { filters: ["red;facetId=color"] };
    const b = { filters: ["XL;facetType=size"] };
    expect(readComparableBodyLeaf(a, b, ["filters", "0"])).toBeUndefined();
  });

  it("does not compare arrays of different length and suffix format slot by slot", () => {
    const a = { filters: ["red;facetId=color", "XL;facetType=size"] };
    const b = { filters: ["x|brand=acme", "y|line=basic", "z|tier=gold"] };
    expect(readComparableBodyLeaf(a, b, ["filters", "0"])).toBeUndefined();
    expect(readComparableBodyLeaf(a, b, ["filters", "1"])).toBeUndefined();
  });

  it("still compares non-identity paths by position", () => {
    expect(readComparableBodyLeaf({ page: 1 }, { page: 2 }, ["page"])).toBe(2);
  });
});

describe("collectRequestBodyValuesByKey across differently shaped arrays", () => {
  it("reports no varying array slot when shape and suffix format differ", () => {
    const a = cap({ filters: ["red;facetId=color", "XL;facetType=size"] });
    const b = cap({ filters: ["x|brand=acme", "y|line=basic", "z|tier=gold"] });
    expect(collectRequestBodyValuesByKey(a, [a, b])!.has("filters")).toBe(false);
  });

  it("reports no varying slot for reordered identical elements", () => {
    const a = cap({ filters: ["red;facetId=color", "XL;facetType=size"] });
    const b = cap({ filters: ["XL;facetType=size", "red;facetId=color"] });
    expect(collectRequestBodyValuesByKey(a, [a, b])!.size).toBe(0);
  });
});

describe("findFrozenVaryingDrillParams across array shapes", () => {
  it("returns [] for reordered and differently shaped facet arrays", () => {
    const a = cap({ filters: ["red;facetId=color", "XL;facetType=size"] });
    const reordered = cap({ filters: ["XL;facetType=size", "red;facetId=color"] });
    const shaped = cap({ filters: ["x|brand=acme", "y|line=basic", "z|tier=gold"] });
    const rendered = JSON.stringify({ filters: ["red;facetId=color", "XL;facetType=size"] });
    expect(findFrozenVaryingDrillParams(a, rendered, [a, reordered, shaped])).toEqual([]);
  });
});
