import { describe, expect, it } from "vitest";
import { emitIndexTs } from "./recon-generate.js";

describe("emitIndexTs digit-leading siteId", () => {
  it("derives a valid identifier", () => {
    const out = emitIndexTs({ siteId: "7eleven-style", pascal: "Site7elevenStyle" });
    expect(out).toContain("site7elevenStyle");
    expect(out).not.toMatch(/\b(const|import \{?)\s*7/);
  });
});
