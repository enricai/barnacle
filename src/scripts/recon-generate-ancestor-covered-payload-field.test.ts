import { describe, expect, it } from "vitest";
import { applyStructuredValuePayloadSubstitutionsForEnvelope } from "./recon-generate";

function run(
  body: Record<string, unknown>,
  envelope: Record<string, unknown>,
  path: string[],
  keys: Map<string, string>
) {
  return applyStructuredValuePayloadSubstitutionsForEnvelope(
    JSON.stringify(body),
    envelope,
    keys,
    new Set(),
    new Map(),
    0,
    path,
    body,
    null,
    new Set()
  );
}

describe("applyStructuredValuePayloadSubstitutionsForEnvelope ancestor coverage", () => {
  it("skips a nested path whose ancestor is already registered", () => {
    const body = { order: { items_attributes: [{ sku: "A" }] } };
    const keys = new Map<string, string>([["order", "z.object({})"]]);
    run(body, body.order, ["order"], keys);
    expect([...keys.keys()]).toEqual(["order"]);
  });

  it("still registers a nested path when no ancestor is registered", () => {
    const body = { order: { items_attributes: [{ sku: "A" }] } };
    const keys = new Map<string, string>();
    run(body, body.order, ["order"], keys);
    expect(keys.size).toBeGreaterThan(0);
  });
});

describe("ancestor-covered descendants at depth > 1", () => {
  it("never freezes a nested descendant as a recorded literal from the ancestor field", () => {
    const body = { cart: { a: { b: "ABC123" } } };
    const keys = new Map<string, string>([["cart", "z.object({})"]]);
    const out = run(body, body.cart, ["cart"], keys);
    expect(out.result).toContain("payload.cart as Record<string, unknown>");
    expect(out.result).not.toContain("ABC123");
  });
});
