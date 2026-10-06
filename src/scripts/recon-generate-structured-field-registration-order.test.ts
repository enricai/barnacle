import { describe, expect, it } from "vitest";
import { applyStructuredValuePayloadSubstitutions } from "@/scripts/recon-generate";

/**
 * A structured body field's declared schema must be inferred from every
 * captured body carrying it, independent of which body is visited first.
 */
describe("structured payload field registration — visiting-order independence", () => {
  const richer = { sorts: [{ criteria: "price", order: "ASC", region: "EU" }] };
  const sparser = { sorts: [{ criteria: "price", order: "ASC" }] };

  const register = (bodies: Array<Record<string, unknown>>): string => {
    const out = new Map<string, string>();
    for (const body of bodies) {
      applyStructuredValuePayloadSubstitutions(JSON.stringify(body), body, out);
    }
    return out.get("sorts") ?? "";
  };

  it("derives the same array-of-objects schema for both visiting orders", () => {
    const a = register([richer, sparser]);
    const b = register([sparser, richer]);
    expect(a).toMatch(/^z\.array\(z\.object\(/);
    expect(a).toBe(b);
    expect(a).toContain("region");
  });
});
