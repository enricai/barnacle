import { describe, expect, it } from "vitest";

import { applyStructuredValuePayloadSubstitutions } from "@/scripts/recon-generate";

/**
 * Unit-pins the pre-write guard in
 * `applyStructuredValuePayloadSubstitutionsForEnvelope`: when a key's array/
 * object span in the TEMPLATE text already carries a `${payload.` accessor
 * (as left behind by an earlier splice pass in the same pipeline run), the
 * generic wholesale-swallow pass must leave that span untouched instead of
 * overwriting it with `${JSON.stringify(payload.<key>)}` — even though
 * `parsedBody` itself still holds the original raw array for that key. A
 * sibling array field with no such accessor anywhere in its span is still
 * swallowed normally.
 */
describe("applyStructuredValuePayloadSubstitutions — pre-spliced span preservation", () => {
  it("leaves an already-spliced `${payload.` span untouched while still swallowing a sibling span", () => {
    const parsedBody = {
      regions: ["north;tag=x"],
      tags: ["a", "b"],
    };
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const regionsSpan = "[`${payload.region};tag=x`]";
    const template = `{"regions":${regionsSpan},"tags":${JSON.stringify(parsedBody.tags)}}`;
    const outStructuredKeys = new Map<string, string>();

    const result = applyStructuredValuePayloadSubstitutions(
      template,
      parsedBody,
      outStructuredKeys,
      new Map(),
      new Set(),
      new Map()
    );

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedTagsSub = "${JSON.stringify(payload.tags)}";

    expect(result).toContain(`"regions":${regionsSpan}`);
    expect(result).toContain(`"tags":${expectedTagsSub}`);
    expect(outStructuredKeys.has("regions")).toBe(true);
    expect(outStructuredKeys.has("tags")).toBe(true);
  });
});
