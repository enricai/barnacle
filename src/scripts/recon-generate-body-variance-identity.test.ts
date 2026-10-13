import { describe, expect, it } from "vitest";
import {
  collectRequestBodyValuesByKey,
  findFrozenVaryingDrillParams,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

const cap = (body: unknown): Capture =>
  ({ url: "https://x/search", method: "POST", requestPostData: JSON.stringify(body) }) as Capture;

describe("collectRequestBodyValuesByKey identity keying", () => {
  it("ignores array-shape-only differences but keeps real variance", () => {
    const a = cap({ filters: ["red;facetId=color", "XL;facetType=size"], page: 1 });
    const b = cap({ filters: ["M;facetType=size", "red;facetId=color"], page: 2 });
    const byKey = collectRequestBodyValuesByKey(a, [a, b])!;
    expect(byKey.has("filters")).toBe(true);
    expect([...byKey.get("filters")!]).toEqual(["XL;facetType=size"]);
    expect([...byKey.get("page")!]).toEqual(["1"]);
  });

  it("does not flag an identical element in a shifted slot", () => {
    const a = cap({ filters: ["red;facetId=color", "XL;facetType=size"] });
    const b = cap({ filters: ["x;other=y", "red;facetId=color", "XL;facetType=size"] });
    expect(collectRequestBodyValuesByKey(a, [a, b])!.size).toBe(0);
  });
});

describe("findFrozenVaryingDrillParams identity keying on open-ended suffixes", () => {
  const filtersCap = (filters: string[]): Capture =>
    ({
      url: "https://x/pricing/",
      method: "POST",
      requestHeaders: {},
      requestPostData: JSON.stringify({ filters }),
    }) as unknown as Capture;

  it("does not freeze elements whose suffix carries hyphens or colons across differently shaped arrays", () => {
    const ids = ["red-1;filterId=color-red", "a;filterId=size:xl", "b;filterId=brand-a.b"];
    const types = [ids[0]!, ids[1]!, "NIGHT;filterType=night-out", "SALE;filterType=promo:x"];
    const shapes = [ids.slice(0, 1), ids, types, [...types].reverse()].map(filtersCap);
    for (const shape of shapes) {
      expect(findFrozenVaryingDrillParams(shape, shape.requestPostData!, shapes)).toEqual([]);
    }
  });

  it("still reports the same identity carrying a different value", () => {
    const a = filtersCap(["red;filterId=color-red", "x;filterId=size-xl"]);
    const b = filtersCap(["x;filterId=size-xl", "blue;filterId=color-red"]);
    const frozen = findFrozenVaryingDrillParams(a, a.requestPostData!, [a, b]);
    expect(frozen.map((f) => f.key)).toEqual(["filters.0"]);
  });
});
