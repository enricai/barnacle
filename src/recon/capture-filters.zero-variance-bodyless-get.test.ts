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
    expect(isZeroVarianceRepeatCapture(all[0]!, all)).toBe(false);
  });
  it("drops identical-URL repeats with no business state", () => {
    const all = [1, 2, 3].map(() => cap("https://x.test/api/ping?limit=1", {}));
    expect(isZeroVarianceRepeatCapture(all[0]!, all)).toBe(true);
  });
});
