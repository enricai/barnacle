import { describe, expect, it } from "vitest";

import { emitBrowserFlowTs } from "@/scripts/recon-generate";

/**
 * F3: the generator has no reliable way to know which CDN fronts a given
 * site, so the comment explaining the SPA-hydration wait must stay
 * vendor-neutral rather than hardcoding "Cloudflare".
 */
describe("emitBrowserFlowTs SPA-hydration wait comment (F3)", () => {
  it("does not hardcode Cloudflare and still explains the wait generically", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "some-site",
      pascal: "SomeSite",
      baseUrl: "https://example.com",
      flowSteps: [],
      isSubmissionFlow: false,
    });

    expect(code).not.toContain("Cloudflare");
    expect(code).toContain("waitForSpaReady(page, logger)");
    expect(code).toMatch(/bot-managed|CDN-fronted/);
  });
});
