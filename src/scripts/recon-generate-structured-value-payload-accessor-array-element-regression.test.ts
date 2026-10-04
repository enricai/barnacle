import { describe, expect, it } from "vitest";

import {
  applyStructuredValuePayloadSubstitutions,
  type StateVarBinding,
} from "@/scripts/recon-generate";

/**
 * Unit-pins the `payloadAccessorExcludeValues` parameter added to
 * `applyStructuredValuePayloadSubstitutions`: a captured array field whose
 * leaf textually equals a value already registered in the payload-accessor
 * map (the same map `applyFacetSplicePayloadSubstitutions`-style callers use
 * for literal splicing) must be left as literal text instead of being
 * wholesale-swallowed into `${JSON.stringify(payload.<key>)}` — mirroring
 * the sibling regression file's coverage of the two PRE-EXISTING exclusion
 * sources (`unconditionalExcludeValues`/`joinFieldValues` and
 * `restrictedExcludeSourceByValue`/`priorStepStateBindings`), which this
 * file re-runs unchanged to prove the new parameter doesn't displace them.
 */
describe("applyStructuredValuePayloadSubstitutions — payload-accessor literal exclusion", () => {
  it("excludes an array field whose leaf matches a registered payload-accessor value, while a sibling array field with no match is still swallowed", () => {
    const parsedBody = {
      // Matches a registered payload-accessor value — must stay literal so
      // the downstream splice pass can still thread it.
      regions: ["north", "south"],
      // Control: no accessor-value coincidence — swallowed as before.
      tags: ["clearance", "newArrivals"],
    };
    const template = JSON.stringify(parsedBody);
    const outStructuredKeys = new Map<string, string>();
    const payloadAccessorExcludeValues = new Map<string, string>([["north", "payload.region"]]);

    const result = applyStructuredValuePayloadSubstitutions(
      template,
      parsedBody,
      outStructuredKeys,
      new Map(),
      new Set(),
      payloadAccessorExcludeValues
    );

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedTagsSub = "${JSON.stringify(payload.tags)}";

    expect(result).toContain(`"regions":${JSON.stringify(parsedBody.regions)}`);
    expect(result).toContain(`"tags":${expectedTagsSub}`);
    expect(outStructuredKeys.has("regions")).toBe(false);
    expect(outStructuredKeys.has("tags")).toBe(true);
  });

  it("still excludes unconditionally on a join-field value match, with payloadAccessorExcludeValues present but unused", () => {
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
      new Set(["2"]),
      new Map()
    );

    expect(result).toBe(template);
    expect(outStructuredKeys.has("lineItems")).toBe(false);
  });

  it("still excludes a field whose leaf equals a restricted prior-step value under a correlating key name, with payloadAccessorExcludeValues present but unused", () => {
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
      priorStepStateBindings,
      new Set(),
      new Map()
    );

    expect(result).toBe(template);
    expect(outStructuredKeys.has("lineItems")).toBe(false);
  });

  it("still excludes unconditionally on an unrestricted (name-free) prior-step value match, with payloadAccessorExcludeValues present but unused", () => {
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
      priorStepStateBindings,
      new Set(),
      new Map()
    );

    expect(result).toBe(template);
    expect(outStructuredKeys.has("lineItems")).toBe(false);
  });

  it("still threads a field whose leaf coincidentally equals an unrelated restricted prior-step value, with payloadAccessorExcludeValues present but unused", () => {
    const parsedBody = {
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
      priorStepStateBindings,
      new Set(),
      new Map()
    );

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedLineItemsSub = "${JSON.stringify(payload.lineItems)}";

    expect(result).toContain(`"lineItems":${expectedLineItemsSub}`);
    expect(outStructuredKeys.has("lineItems")).toBe(true);
  });
});
