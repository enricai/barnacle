import { describe, expect, it } from "vitest";
import { isPassiveNoopInstruction } from "@/scraper/phantom-click";
import { RECON_FLOW_SCHEMA } from "@/lib/llm/schemas";

describe("passive no-op steps", () => {
  it("treats a negated-action wait step as a no-op", () => {
    expect(
      isPassiveNoopInstruction("Do not click anything on the page; simply wait for results to load")
    ).toBe(true);
    expect(isPassiveNoopInstruction("Wait for the report to render")).toBe(true);
  });
  it("does not treat actionable steps as no-ops", () => {
    expect(isPassiveNoopInstruction("Click the Search button")).toBe(false);
    expect(isPassiveNoopInstruction("Fill the query field, do not click submit")).toBe(false);
  });
  it("accepts payloadField on navigateTo steps", () => {
    const r = RECON_FLOW_SCHEMA.parse([
      { step: "Go to results", navigateTo: "https://example.org/r", payloadField: "query" },
    ]);
    expect((r[0] as { payloadField?: string }).payloadField).toBe("query");
  });
});
