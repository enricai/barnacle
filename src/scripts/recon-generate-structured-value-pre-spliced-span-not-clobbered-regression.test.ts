import { describe, expect, it } from "vitest";

import { applyStructuredValuePayloadSubstitutions } from "@/scripts/recon-generate";

/**
 * Unit-pins the fix for the reported clobber: a key's array span that an
 * earlier pass in the same pipeline run (e.g. the optional-facet
 * array-element splice) has already rewritten to carry a `${payload.<field>}`
 * accessor must survive this pass untouched, even when none of the three
 * exclusion sources (prior-step state bindings, join-field values, or
 * registered payload-accessor literals) match the field's ORIGINAL parsed
 * leaf values. A sibling array field with no pre-existing accessor and no
 * exclusion-source match is still wholesale-swallowed exactly as before.
 */
describe("applyStructuredValuePayloadSubstitutions — pre-spliced span is left intact", () => {
  it("leaves an already-spliced array span alone while a sibling array with no match is still frozen", () => {
    const parsedBody = {
      tags: ["north-ridge", "sale"],
      category: ["outerwear", "footwear"],
    };
    // Simulates the output of an earlier splice pass: the `tags` span has
    // already had one element replaced with a `${payload.regionFacet}`
    // accessor reference, even though "north-ridge" (the original leaf
    // value) matches none of the three exclusion sources below.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: simulating an already-spliced template
    const template =
      '{"tags":["${payload.regionFacet}","sale"],"category":["outerwear","footwear"]}';
    const outStructuredKeys = new Map<string, string>();

    const result = applyStructuredValuePayloadSubstitutions(
      template,
      parsedBody,
      outStructuredKeys
    );

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedTagsSpan = '["${payload.regionFacet}","sale"]';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedCategorySub = "${JSON.stringify(payload.category)}";

    expect(result).toContain(`"tags":${expectedTagsSpan}`);
    expect(outStructuredKeys.has("tags")).toBe(false);

    expect(result).toContain(`"category":${expectedCategorySub}`);
    expect(outStructuredKeys.has("category")).toBe(true);
  });

  it("still threads a field whose leaf text merely contains the literal word 'payload.' as ordinary data", () => {
    const parsedBody = {
      tags: ["view payload.json", "sale"],
    };
    const template = '{"tags":["view payload.json","sale"]}';
    const outStructuredKeys = new Map<string, string>();

    const result = applyStructuredValuePayloadSubstitutions(
      template,
      parsedBody,
      outStructuredKeys
    );

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedTagsSub = "${JSON.stringify(payload.tags)}";
    expect(result).toContain(`"tags":${expectedTagsSub}`);
    expect(outStructuredKeys.has("tags")).toBe(true);
  });
});
