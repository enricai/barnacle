import { describe, expect, it } from "vitest";
import { buildDeepMarkerCentreExpr } from "@/scraper/flow-runner";

describe("buildDeepMarkerCentreExpr", () => {
  it("pierces shadow roots and centres before hit-testing", () => {
    const expr = buildDeepMarkerCentreExpr('[data-x="1"]');
    expect(expr).toContain("shadowRoot");
    expect(expr).toContain('block: "center"');
    expect(expr).toContain("elementFromPoint");
  });
});
