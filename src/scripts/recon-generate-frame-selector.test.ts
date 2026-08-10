import { describe, expect, it } from "vitest";

import { emitBrowserFlowTs } from "@/scripts/recon-generate";

/** Minimal opts that satisfy emitBrowserFlowTs for a submission flow. Kept
 * separate per this file's own fixture rather than imported from
 * recon-generate.test.ts, so this file stays disjoint from the sibling
 * suite's capture chain. */
const BASE_OPTS = {
  siteId: "recon-site-3",
  pascal: "ReconSite3",
  baseUrl: "https://careers.example.org",
  isSubmissionFlow: true,
  flowSteps: ["Click the Manual Application button"],
};

describe("emitBrowserFlowTs — frameSelector emission into runHealingFlow", () => {
  it("emits a runHealingFlow call whose deps carry the flow's frameSelector, so a generated plugin inherits cross-origin iframe capability", () => {
    const { code } = emitBrowserFlowTs({
      ...BASE_OPTS,
      frameSelector: "#apply_frame",
    });

    expect(code).toMatch(/runHealingFlow\(\{[\s\S]*frameSelector: "#apply_frame",[\s\S]*\}\)/);
  });

  it("omits the frameSelector key entirely when the flow declares none — byte-identical to today's output for every existing site", () => {
    const withoutFrameSelector = emitBrowserFlowTs({ ...BASE_OPTS });

    expect(withoutFrameSelector.code).not.toContain("frameSelector");
  });

  it("produces the exact same code whether frameSelector is omitted or explicitly undefined, so existing generated sites see no diff", () => {
    const omitted = emitBrowserFlowTs({ ...BASE_OPTS });
    const explicitUndefined = emitBrowserFlowTs({ ...BASE_OPTS, frameSelector: undefined });

    expect(explicitUndefined.code).toEqual(omitted.code);
  });
});
