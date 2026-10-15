import { describe, expect, it } from "vitest";
import { DROP_ZONE_SELECTORS } from "@/scraper/upload-affordance-expr";

describe("DROP_ZONE_SELECTORS", () => {
  it("keeps class and tag selectors", () => {
    expect(DROP_ZONE_SELECTORS).toContain("[class*='dropzone']");
    expect(DROP_ZONE_SELECTORS).toContain("uapp-upload");
  });

  it("includes attribute-identified drop areas", () => {
    expect(DROP_ZONE_SELECTORS).toContain("[data-testid*='drop' i][data-testid*='file' i]");
  });
});
