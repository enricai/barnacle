import { describe, expect, it } from "vitest";
import { collectRequestBodyValuesByKey } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

const cap = (body: unknown): Capture =>
  ({ url: "https://x/search", method: "POST", requestPostData: JSON.stringify(body) }) as Capture;

describe("collectRequestBodyValuesByKey — genuine variance still reported", () => {
  it("flags a same-shape array whose element identity differs across captures", () => {
    const a = cap({ filters: ["red;facetId=color", "XL;facetType=size"] });
    const b = cap({ filters: ["blue;facetId=color", "XL;facetType=size"] });
    const byKey = collectRequestBodyValuesByKey(a, [a, b])!;
    expect(byKey.has("filters")).toBe(true);
    expect([...byKey.get("filters")!]).toEqual(["red;facetId=color"]);
  });

  it("flags a same-length array of objects with a genuinely different element", () => {
    const a = cap({ items: [{ sku: "a" }, { sku: "b" }] });
    const b = cap({ items: [{ sku: "a" }, { sku: "c" }] });
    const byKey = collectRequestBodyValuesByKey(a, [a, b])!;
    expect(byKey.has("items")).toBe(true);
  });

  it("still flags a varying scalar body field", () => {
    const a = cap({ filters: ["red;facetId=color"], page: 1 });
    const b = cap({ filters: ["red;facetId=color"], page: 2 });
    const byKey = collectRequestBodyValuesByKey(a, [a, b])!;
    expect([...byKey.get("page")!]).toEqual(["1"]);
    expect(byKey.has("filters")).toBe(false);
  });
});
