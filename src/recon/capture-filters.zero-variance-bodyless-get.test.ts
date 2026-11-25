import { describe, expect, it } from "vitest";
import { isZeroVarianceRepeatCapture } from "./capture-filters.js";

const cap = (url: string, responseBody: unknown) => ({
  method: "GET",
  url,
  requestPostData: null,
  responseHeaders: { "content-type": "application/json" },
  responseBody,
});

describe("isZeroVarianceRepeatCapture bodyless GET", () => {
  it("keeps a search GET with fixed limit/offset but varying facets", () => {
    const all = ["a", "b", "c"].map((f, i) =>
      cap(`https://x.test/api/search?limit=10&offset=0&facet=${f}`, {
        results: [{ id: i, name: `item-${f}`, price: 10 + i }],
      })
    );
    const [first] = all;
    if (!first) throw new Error("fixture must produce captures");
    expect(isZeroVarianceRepeatCapture(first, all)).toBe(false);
  });
  it("drops identical-URL repeats with no business state", () => {
    const all = [1, 2, 3].map(() => cap("https://x.test/api/ping?limit=1", {}));
    const [first] = all;
    if (!first) throw new Error("fixture must produce captures");
    expect(isZeroVarianceRepeatCapture(first, all)).toBe(true);
  });
  it("keeps a varying search GET whose parsed body arrived without a content-type header", () => {
    const all = ["a", "b", "c"].map((f, i) => ({
      method: "GET",
      url: `https://x.test/api/search?limit=10&facet=${f}`,
      requestPostData: null,
      responseHeaders: {},
      responseBody: { results: [{ id: i, name: `item-${f}` }] },
    }));
    const [first] = all;
    if (!first) throw new Error("fixture must produce captures");
    expect(isZeroVarianceRepeatCapture(first, all)).toBe(false);
  });
  it("still treats a declared non-JSON response as no business state", () => {
    const all = ["a", "b", "c"].map((f) => ({
      method: "GET",
      url: `https://x.test/px?id=fixed&t=${f}`,
      requestPostData: null,
      responseHeaders: { "content-type": "image/gif" },
      responseBody: { results: [{ id: 1, name: "n" }] },
    }));
    const [first] = all;
    if (!first) throw new Error("fixture must produce captures");
    expect(isZeroVarianceRepeatCapture(first, all)).toBe(true);
  });
});
