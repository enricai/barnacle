import { describe, expect, it } from "vitest";

import {
  applyStructuredValuePayloadSubstitutions,
  type StateVarBinding,
} from "@/scripts/recon-generate";

/**
 * Regression for the reported gap: a top-level array/object-valued field was
 * silently excluded from `applyStructuredValuePayloadSubstitutions`'s
 * threading pass whenever ANY of its own primitive leaves happened to equal
 * a prior step's produced value — even when that value's source field name
 * named a completely different concept than the leaf's own key. A short
 * scalar leaf (e.g. a line-item `quantity`) coincidentally equalling an
 * unrelated prior-step value (e.g. a `pageSize`) must not exclude the whole
 * field; only a RESTRICTED value (one with a real, name-correlated source)
 * should.
 */
describe("applyStructuredValuePayloadSubstitutions — restricted value-coincidence false positive", () => {
  it("threads both a control array field and a field whose leaf coincidentally equals an unrelated restricted prior-step value", () => {
    const parsedBody = {
      // Control: already known to thread correctly with no prior-step values at all.
      filters: ["clearance", "newArrivals"],
      // Broken: one leaf ("2") coincidentally equals a prior step's RESTRICTED
      // "pageSize" value, but "quantity" does not correlate with "pageSize".
      lineItems: [
        { sku: "WIDGET-1", quantity: 2 },
        { sku: "WIDGET-2", quantity: 1 },
      ],
    };
    const template = JSON.stringify(parsedBody);
    const outStructuredKeys = new Map<string, string>();

    const priorStepStateBindings = new Map<string, StateVarBinding>([
      [
        "2",
        {
          varName: "pageSize0",
          sourceName: "pageSize",
          restricted: true,
          unconditional: false,
        },
      ],
    ]);

    const result = applyStructuredValuePayloadSubstitutions(
      template,
      parsedBody,
      outStructuredKeys,
      priorStepStateBindings
    );

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedFiltersSub = "${JSON.stringify(payload.filters)}";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedLineItemsSub = "${JSON.stringify(payload.lineItems)}";

    expect(result).toContain(`"filters":${expectedFiltersSub}`);
    expect(result).toContain(`"lineItems":${expectedLineItemsSub}`);
    expect(outStructuredKeys.has("filters")).toBe(true);
    expect(outStructuredKeys.has("lineItems")).toBe(true);
  });

  it("still excludes a field whose leaf equals a restricted prior-step value under a correlating key name", () => {
    const parsedBody = {
      lineItems: [{ sku: "WIDGET-1", quantity: 2 }],
    };
    const template = JSON.stringify(parsedBody);
    const outStructuredKeys = new Map<string, string>();

    const priorStepStateBindings = new Map<string, StateVarBinding>([
      [
        "2",
        {
          varName: "itemQuantity0",
          sourceName: "quantity",
          restricted: true,
          unconditional: false,
        },
      ],
    ]);

    const result = applyStructuredValuePayloadSubstitutions(
      template,
      parsedBody,
      outStructuredKeys,
      priorStepStateBindings
    );

    expect(result).toBe(template);
    expect(outStructuredKeys.has("lineItems")).toBe(true);
  });

  it("still excludes unconditionally on an unrestricted (name-free) prior-step value match", () => {
    const parsedBody = {
      lineItems: [{ sku: "WIDGET-1", quantity: 2 }],
    };
    const template = JSON.stringify(parsedBody);
    const outStructuredKeys = new Map<string, string>();

    const priorStepStateBindings = new Map<string, StateVarBinding>([
      [
        "2",
        {
          varName: "chainValue0",
          sourceName: "0",
          restricted: false,
          unconditional: true,
        },
      ],
    ]);

    const result = applyStructuredValuePayloadSubstitutions(
      template,
      parsedBody,
      outStructuredKeys,
      priorStepStateBindings
    );

    expect(result).toBe(template);
    expect(outStructuredKeys.has("lineItems")).toBe(true);
  });

  it("still excludes unconditionally on a join-field value match", () => {
    const parsedBody = {
      lineItems: [{ sku: "WIDGET-1", quantity: 2 }],
    };
    const template = JSON.stringify(parsedBody);
    const outStructuredKeys = new Map<string, string>();

    const result = applyStructuredValuePayloadSubstitutions(
      template,
      parsedBody,
      outStructuredKeys,
      new Map(),
      new Set(["2"])
    );

    expect(result).toBe(template);
    expect(outStructuredKeys.has("lineItems")).toBe(true);
  });
});
