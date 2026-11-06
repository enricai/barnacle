import { describe, expect, it } from "vitest";

import {
  buildMarkShadowInteractiveDescendantExpr,
  buildUnmarkShadowDescendantExpr,
} from "@/scraper/browser-click-expr";
import { shadowXpathLookupExpr } from "@/scraper/shadow-xpath";

const XPATH = "//shop-app//button[1]";

describe("click-expr xpath lookups route through the shadow-aware resolver", () => {
  it("mark/unmark expressions embed the shared lookup and no raw document.evaluate", () => {
    const lookup = shadowXpathLookupExpr(XPATH);
    for (const expr of [
      buildMarkShadowInteractiveDescendantExpr(XPATH, "data-m", "v"),
      buildUnmarkShadowDescendantExpr(XPATH, "data-m", "v"),
    ]) {
      expect(expr).toContain(lookup);
      expect(expr.replace(lookup, "")).not.toMatch(/document\.evaluate\(/);
    }
  });
});
