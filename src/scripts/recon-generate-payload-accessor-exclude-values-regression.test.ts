import { describe, expect, it } from "vitest";

import { applyStructuredValuePayloadSubstitutions } from "@/scripts/recon-generate";

/**
 * Regression for the reported gap: a captured array/object field whose leaf
 * already matches a value registered in `payloadAccessorByValue` (e.g. a
 * facet derived by an earlier step and already wired for substring
 * splicing elsewhere) was wholesale-swallowed into an opaque
 * `${JSON.stringify(payload.<key>)}` blob before the substring-splice pass
 * got a chance to thread it. `payloadAccessorExcludeValues` now excludes
 * those fields unconditionally, the same way `joinFieldValues` already does.
 */
describe("applyStructuredValuePayloadSubstitutions — payloadAccessorExcludeValues", () => {
  it("excludes an array field whose leaf matches a registered payload-accessor literal", () => {
    const parsedBody = {
      filters: ["remote"],
      tags: ["engineering", "backend"],
    };
    const template = JSON.stringify(parsedBody);
    const outStructuredKeys = new Map<string, string>();
    const payloadAccessorExcludeValues = new Map<string, string>([
      ["engineering", "state.departmentCode"],
    ]);

    const result = applyStructuredValuePayloadSubstitutions(
      template,
      parsedBody,
      outStructuredKeys,
      new Map(),
      new Set(),
      payloadAccessorExcludeValues
    );

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedFiltersSub = "${JSON.stringify(payload.filters)}";

    expect(result).toContain(`"filters":${expectedFiltersSub}`);
    expect(result).toContain('"tags":["engineering","backend"]');
    expect(outStructuredKeys.has("filters")).toBe(true);
    expect(outStructuredKeys.has("tags")).toBe(true);
  });

  it("swallows the same array field when no payload-accessor exclusion is registered", () => {
    const parsedBody = {
      filters: ["remote"],
      tags: ["engineering", "backend"],
    };
    const template = JSON.stringify(parsedBody);
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
