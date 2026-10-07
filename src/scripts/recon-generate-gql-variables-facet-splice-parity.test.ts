import { describe, expect, it } from "vitest";
import { renderGqlVariablesExpr } from "@/scripts/recon-generate";

describe("renderGqlVariablesExpr facet splice parity with REST", () => {
  it("splices a facet array and a correlated facet nested inside its elements", () => {
    const expr = renderGqlVariablesExpr(
      { filters: ["widget-x;id=1", { ids: ["widget-x;id=1"] }], cursor: "a" },
      undefined,
      new Set(),
      [{ field: "widgetId", value: "widget-x", optional: false }]
    );
    expect(expr).toContain("`${payload.widgetId};id=1`");
    expect(expr).not.toContain('"widget-x;id=1"');
  });
});
