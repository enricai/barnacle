import { describe, expect, it } from "vitest";

import { applyStructuredValuePayloadSubstitutions } from "@/scripts/recon-generate";

/**
 * Regression for the reported gap: `applyStructuredValuePayloadSubstitutions`
 * bailed out unconditionally whenever the captured body's top-level JSON
 * value was an ARRAY (e.g. a cruise-line multi-room search that batches
 * per-room criteria as `[{...}, {...}]`), so a structured array/object field
 * living inside an array ELEMENT never got the same
 * `${JSON.stringify(payload.<field>)}` treatment its object-rooted sibling
 * (`filters`) already receives. The fix walks into array elements instead of
 * bailing at the top-level `Array.isArray` check.
 */
describe("applyStructuredValuePayloadSubstitutions — top-level array-shaped body", () => {
  it("rewrites a partyMix-shaped structured array field inside each array element, matching sibling `filters` treatment", () => {
    const room1 = {
      roomIndex: 0,
      filters: ["adultsOnly", "balcony"],
      partyMix: [
        { ageType: "ADULT", count: 2 },
        { ageType: "CHILD", count: 1 },
      ],
    };
    const room2 = {
      roomIndex: 1,
      filters: ["oceanView"],
      partyMix: [{ ageType: "ADULT", count: 1 }],
    };
    const parsedBody = [room1, room2];
    const template = JSON.stringify(parsedBody);
    const outStructuredKeys = new Map<string, string>();

    const result = applyStructuredValuePayloadSubstitutions(
      template,
      parsedBody,
      outStructuredKeys
    );

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedFiltersSub = "${JSON.stringify(payload.filters)}";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedPartyMixSub = "${JSON.stringify(payload.partyMix)}";

    expect(result).toContain(`"filters":${expectedFiltersSub}`);
    expect(result).toContain(`"partyMix":${expectedPartyMixSub}`);
    // Both occurrences (one per array element) must be rewritten — a frozen
    // literal for even one element would silently submit a stale party mix.
    expect(result.split(`"filters":${expectedFiltersSub}`).length - 1).toBe(2);
    expect(result.split(`"partyMix":${expectedPartyMixSub}`).length - 1).toBe(2);
    expect(result).not.toContain('"ageType":"ADULT"');
    expect(result).not.toContain('"adultsOnly"');
    expect(outStructuredKeys.has("filters")).toBe(true);
    expect(outStructuredKeys.has("partyMix")).toBe(true);

    // Scalar sibling fields stay untouched literals.
    expect(result).toContain('"roomIndex":0');
    expect(result).toContain('"roomIndex":1');
  });

  it("leaves a top-level array body with no structured envelope fields unchanged", () => {
    const parsedBody = [{ roomIndex: 0, adults: 2 }];
    const template = JSON.stringify(parsedBody);
    const outStructuredKeys = new Map<string, string>();

    const result = applyStructuredValuePayloadSubstitutions(
      template,
      parsedBody,
      outStructuredKeys
    );

    expect(result).toBe(template);
    expect(outStructuredKeys.size).toBe(0);
  });
});
