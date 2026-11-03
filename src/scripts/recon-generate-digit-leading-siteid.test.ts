import { describe, expect, it } from "vitest";
import { emitIndexTs } from "./recon-generate.js";

describe("emitIndexTs digit-leading siteId", () => {
  it("derives a valid identifier", () => {
    const out = emitIndexTs({ siteId: "7-example-shop", pascal: "Site7ExampleShop" });
    expect(out).toContain("site7ExampleShop");
    expect(out).not.toMatch(/\b(const|import \{?)\s*7/);
  });
});
