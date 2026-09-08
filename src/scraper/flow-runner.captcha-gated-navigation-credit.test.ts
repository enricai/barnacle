import { describe, expect, it } from "vitest";

import { hasOriginOrPathChanged } from "@/scraper/flow-runner";

describe("hasOriginOrPathChanged", () => {
  it("returns false when the URL is unchanged", () => {
    expect(
      hasOriginOrPathChanged("https://example.com/checkout", "https://example.com/checkout")
    ).toBe(false);
  });

  it("returns false for a same-origin, same-path change limited to the query string", () => {
    expect(
      hasOriginOrPathChanged(
        "https://example.com/checkout?step=1",
        "https://example.com/checkout?step=2"
      )
    ).toBe(false);
  });

  it("returns true when the path changed on the same origin", () => {
    expect(
      hasOriginOrPathChanged("https://example.com/checkout", "https://example.com/checkout/confirm")
    ).toBe(true);
  });

  it("returns true when the origin changed", () => {
    expect(
      hasOriginOrPathChanged("https://example.com/checkout", "https://secure.example.com/checkout")
    ).toBe(true);
  });
});
