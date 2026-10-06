import { describe, expect, it } from "vitest";
import { applyPayloadKeyValueSubstitutions } from "@/scripts/recon-generate";

describe("applyPayloadKeyValueSubstitutions structured/scalar order", () => {
  const arrayBody = { items: [{ id: "a" }] };
  const scalarBody = { items: "x" };
  for (const bodies of [
    [arrayBody, scalarBody],
    [scalarBody, arrayBody],
  ]) {
    it(`registers array-of-objects schema for order ${JSON.stringify(bodies)}`, () => {
      const additional = new Map();
      const structured = new Map<string, string>();
      applyPayloadKeyValueSubstitutions("{}", undefined, bodies, additional, [], structured);
      expect(structured.get("items")).toContain("z.array");
      expect(additional.has("items")).toBe(false);
    });
  }
});
