import { describe, expect, it } from "vitest";

import type { ReconVocabulary } from "@/recon/vocabulary";
import { emitBrowserFlowTs } from "@/scripts/recon-generate";

/** Concatenation trick (matches recon-generate.test.ts's RECON_EMAIL_TOKEN)
 * so Biome's noTemplateCurlyInString rule doesn't flag the literal `${...}`. */
const RECON_PHONE_TOKEN = `$${"{RECON_PHONE}"}`;
const RECON_PASSWORD_TOKEN = `$${"{RECON_PASSWORD}"}`;

/** Minimal vocabulary mapping "phone number" to a Phone payload field, scoped
 * to this test only. */
const PHONE_VOCABULARY: ReconVocabulary = {
  subject: /\b(the\s+)?(test\s+)?(candidate|applicant)'?s\b/i,
  exclusions: [],
  table: [[/\bphone number\b/i, "Phone"]],
};

describe("emitBrowserFlowTs — RECON_PHONE splices to payload.Phone, never survives literally", () => {
  const { code } = emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    flowSteps: [
      `Fill in the Phone Number field (data-automation-id='phone') with '${RECON_PHONE_TOKEN}'`,
    ],
    vocabulary: PHONE_VOCABULARY,
  });

  it("splices a payload.Phone reference at the value site", () => {
    expect(code).toContain(`$${"{payload.Phone}"}`);
  });

  it("leaves the data-automation-id selector untouched", () => {
    expect(code).toContain("data-automation-id='phone'");
  });

  it("emits no un-spliced or escaped RECON_PHONE token", () => {
    expect(code).not.toContain(RECON_PHONE_TOKEN);
    expect(code).not.toContain(`\\${RECON_PHONE_TOKEN}`);
    expect(code).not.toContain("RECON_PHONE");
  });
});

describe("emitBrowserFlowTs — RECON_PASSWORD resolves to a generated throwaway, never survives literally", () => {
  const { code } = emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    flowSteps: [
      `Fill in the Password field (data-automation-id='password') with '${RECON_PASSWORD_TOKEN}'`,
    ],
    vocabulary: PHONE_VOCABULARY,
  });

  it("emits no un-spliced or escaped RECON_PASSWORD token", () => {
    expect(code).not.toContain(RECON_PASSWORD_TOKEN);
    expect(code).not.toContain(`\\${RECON_PASSWORD_TOKEN}`);
    expect(code).not.toContain("RECON_PASSWORD");
  });

  it("replaces the static source instruction's value site with a non-static splice expression", () => {
    expect(code).not.toMatch(/'?\$\{RECON_PASSWORD\}'?/);
    expect(code).toMatch(/\$\{throwawayPassword\}|\$\{payload\.\w+\}/);
  });
});
