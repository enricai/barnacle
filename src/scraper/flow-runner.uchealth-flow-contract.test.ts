import { describe, expect, it } from "vitest";
import { RECON_FLOW_FILE_SCHEMA } from "@/scripts/recon-browser";

/**
 * Pins the shipped UCHealth/Talemetry recon flow's structural contract so a
 * future edit to the flow file cannot silently reintroduce the mid-flow
 * iframe regression fixed by `flow-runner.iframe-e2e.test.ts`'s "mid-flow
 * iframe attachment" suite: the flow declares `frameSelector`, its "Apply
 * now" CTA (which mounts `#talemetry_apply_iframe`) runs before the
 * in-iframe "Manual Application" step, and that in-iframe step is
 * non-optional. This flow lives in the downstream `autoapply` repo
 * (`src/sites/uchealth/recon-flow.json`), not in this repo, so the shape is
 * inlined here as a fixture literal rather than read from disk — the
 * assertion still rides `RECON_FLOW_FILE_SCHEMA`, the real parser, rather
 * than a hand-rolled check.
 *
 * Offline and network-free: this only exercises Zod parsing, no browser, no
 * Stagehand, no Playwright.
 */
const UCHEALTH_FLOW = {
  frameSelector: "#talemetry_apply_iframe",
  steps: [
    { step: "Dismiss the cookie consent banner if present", optional: true, upload: false },
    { step: "Click the 'Apply now' button", optional: false, upload: false },
    { step: "Click the 'Manual Application' button", optional: false, upload: false },
    { step: "Fill in First Name", optional: false, upload: false },
    { step: "Fill in Last Name", optional: false, upload: false },
    { step: "Upload resume", optional: false, upload: true },
    { step: "Click the final Submit button", optional: false, upload: false },
  ],
};

describe("UCHealth recon flow artifact — structural contract", () => {
  it("parses under RECON_FLOW_FILE_SCHEMA and declares the Talemetry iframe selector", () => {
    const result = RECON_FLOW_FILE_SCHEMA.safeParse(UCHEALTH_FLOW);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Array.isArray(result.data)).toBe(false);
    if (Array.isArray(result.data)) return;
    expect(result.data.frameSelector).toBe("#talemetry_apply_iframe");
  });

  it("orders the Apply CTA step before the in-iframe Manual Application step", () => {
    const result = RECON_FLOW_FILE_SCHEMA.safeParse(UCHEALTH_FLOW);

    expect(result.success).toBe(true);
    if (!result.success) return;
    if (Array.isArray(result.data)) return;

    const steps = result.data.steps;
    const applyIndex = steps.findIndex((s) => typeof s !== "string" && /apply now/i.test(s.step));
    const manualApplicationIndex = steps.findIndex(
      (s) => typeof s !== "string" && /manual application/i.test(s.step)
    );

    expect(applyIndex).toBeGreaterThanOrEqual(0);
    expect(manualApplicationIndex).toBeGreaterThanOrEqual(0);
    expect(applyIndex).toBeLessThan(manualApplicationIndex);
  });

  it("keeps the Manual Application step non-optional (the click that must reach the mid-flow iframe)", () => {
    const result = RECON_FLOW_FILE_SCHEMA.safeParse(UCHEALTH_FLOW);

    expect(result.success).toBe(true);
    if (!result.success) return;
    if (Array.isArray(result.data)) return;

    const manualApplicationStep = result.data.steps.find(
      (s) => typeof s !== "string" && /manual application/i.test(s.step)
    );

    expect(manualApplicationStep).toBeDefined();
    if (!manualApplicationStep || typeof manualApplicationStep === "string") return;
    expect(manualApplicationStep.optional).toBe(false);
  });

  it("flags the resume step as an upload and keeps the final Submit step non-optional", () => {
    const result = RECON_FLOW_FILE_SCHEMA.safeParse(UCHEALTH_FLOW);

    expect(result.success).toBe(true);
    if (!result.success) return;
    if (Array.isArray(result.data)) return;

    const uploadStep = result.data.steps.find(
      (s) => typeof s !== "string" && /upload resume/i.test(s.step)
    );
    const submitStep = result.data.steps.find(
      (s) => typeof s !== "string" && /final submit/i.test(s.step)
    );

    expect(uploadStep).toBeDefined();
    if (!uploadStep || typeof uploadStep === "string") return;
    expect(uploadStep.upload).toBe(true);

    expect(submitStep).toBeDefined();
    if (!submitStep || typeof submitStep === "string") return;
    expect(submitStep.optional).toBe(false);
  });

  it("runs the resume upload and final Submit steps after Manual Application", () => {
    const result = RECON_FLOW_FILE_SCHEMA.safeParse(UCHEALTH_FLOW);

    expect(result.success).toBe(true);
    if (!result.success) return;
    if (Array.isArray(result.data)) return;

    const steps = result.data.steps;
    const manualApplicationIndex = steps.findIndex(
      (s) => typeof s !== "string" && /manual application/i.test(s.step)
    );
    const uploadIndex = steps.findIndex(
      (s) => typeof s !== "string" && /upload resume/i.test(s.step)
    );
    const submitIndex = steps.findIndex(
      (s) => typeof s !== "string" && /final submit/i.test(s.step)
    );

    expect(manualApplicationIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBeGreaterThanOrEqual(0);
    expect(submitIndex).toBeGreaterThanOrEqual(0);
    expect(manualApplicationIndex).toBeLessThan(uploadIndex);
    expect(manualApplicationIndex).toBeLessThan(submitIndex);
  });
});
