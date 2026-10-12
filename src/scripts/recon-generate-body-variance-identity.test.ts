import { describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-generate";
import { collectRequestBodyValuesByKey } from "@/scripts/recon-generate";

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
