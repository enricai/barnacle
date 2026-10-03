import { describe, expect, it } from "vitest";

import { collectUnboundLiterals } from "@/scripts/recon-generate";

/**
 * Narrower unit coverage for collectUnboundLiterals's composite-value
 * detection (bugfix-004), independent of the full CLI pipeline: pins the
 * exact shape the e2e test in
 * recon-generate-1-12-76-single-capture-composite-field-threading-e2e.test.ts
 * drives end to end — a single-observed array-of-objects field beside a
 * known-working array-of-strings field — at the function boundary, so a
 * regression here is diagnosable without re-running the CLI.
 */
describe("collectUnboundLiterals — composite field beside a known-working array-of-strings sibling", () => {
  it("flags only the composite field that stayed frozen, leaving the correctly-threaded sibling array unflagged", () => {
    const parsedBody = {
      attendeeSlots: [
        { category: "STANDARD", quantity: 2 },
        { category: "PREMIUM", quantity: 1 },
      ],
      tags: ["early-bird", "waitlist-eligible"],
    };
    // attendeeSlots is still a bare literal; tags was correctly substituted.
    const finalTemplate = `{"attendeeSlots":${JSON.stringify(parsedBody.attendeeSlots)},"tags":\${JSON.stringify(payload.tags)}}`;

    const unbound = collectUnboundLiterals(finalTemplate, parsedBody, new Set());

    expect(unbound).toContain("attendeeSlots");
    expect(unbound).not.toContain("tags");
  });

  it("flags neither field once both the composite and the array-of-strings field are correctly substituted", () => {
    const parsedBody = {
      attendeeSlots: [{ category: "STANDARD", quantity: 2 }],
      tags: ["early-bird"],
    };
    const finalTemplate =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      '{"attendeeSlots":${JSON.stringify(payload.attendeeSlots)},"tags":${JSON.stringify(payload.tags)}}';

    const unbound = collectUnboundLiterals(finalTemplate, parsedBody, new Set());

    expect(unbound).not.toContain("attendeeSlots");
    expect(unbound).not.toContain("tags");
  });
});
