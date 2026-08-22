import { describe, expect, it } from "vitest";
import { RECON_FLOW_FILE_SCHEMA } from "@/scripts/recon-browser";

/**
 * Pins the object-form recon flow's structural contract — `frameSelector`
 * present, an advance step ordered before an in-iframe step, that in-iframe
 * step non-optional, an upload step flagged, and a non-optional submit step
 * ordered last — using a fully synthetic flow rather than any shipped site's
 * real data. Site-specific flow files (and any contract test tied to their
 * real content) live in the downstream `autoapply` repo's `src/sites/<id>/`.
 */
const EXAMPLE_FLOW = {
  displayName: "Example Careers",
  frameSelector: "#example_apply_iframe",
  steps: [
    { step: "Click the 'Apply now' button", optional: false, upload: false },
    { step: "Click the 'Continue in iframe' button", optional: false, upload: false },
    { step: "Fill in First Name", optional: false, upload: false },
    { step: "Fill in Last Name", optional: false, upload: false },
    { step: "Upload resume", optional: false, upload: true },
    { step: "Click the final Submit button", optional: false, upload: false, submitStep: true },
  ],
};

describe("recon-browser/RECON_FLOW_FILE_SCHEMA — cross-frame flow structural contract", () => {
  it("parses under RECON_FLOW_FILE_SCHEMA and declares the iframe selector", () => {
    const result = RECON_FLOW_FILE_SCHEMA.safeParse(EXAMPLE_FLOW);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Array.isArray(result.data)).toBe(false);
    if (Array.isArray(result.data)) return;
    expect(result.data.frameSelector).toBe("#example_apply_iframe");
  });

  it("accepts a flow-authored displayName and returns it verbatim", () => {
    const result = RECON_FLOW_FILE_SCHEMA.safeParse(EXAMPLE_FLOW);

    expect(result.success).toBe(true);
    if (!result.success) return;
    if (Array.isArray(result.data)) return;
    expect(result.data.displayName).toBe("Example Careers");
  });

  it("keeps displayName optional when a flow omits it", () => {
    const { displayName: _displayName, ...flowWithoutDisplayName } = EXAMPLE_FLOW;
    const result = RECON_FLOW_FILE_SCHEMA.safeParse(flowWithoutDisplayName);

    expect(result.success).toBe(true);
    if (!result.success) return;
    if (Array.isArray(result.data)) return;
    expect(result.data.displayName).toBeUndefined();
  });

  it("orders the Apply CTA step before the in-iframe Continue step", () => {
    const result = RECON_FLOW_FILE_SCHEMA.safeParse(EXAMPLE_FLOW);

    expect(result.success).toBe(true);
    if (!result.success) return;
    if (Array.isArray(result.data)) return;

    const steps = result.data.steps;
    const applyIndex = steps.findIndex((s) => typeof s !== "string" && /apply now/i.test(s.step));
    const continueIndex = steps.findIndex(
      (s) => typeof s !== "string" && /continue in iframe/i.test(s.step)
    );

    expect(applyIndex).toBeGreaterThanOrEqual(0);
    expect(continueIndex).toBeGreaterThanOrEqual(0);
    expect(applyIndex).toBeLessThan(continueIndex);
  });

  it("keeps the in-iframe Continue step non-optional", () => {
    const result = RECON_FLOW_FILE_SCHEMA.safeParse(EXAMPLE_FLOW);

    expect(result.success).toBe(true);
    if (!result.success) return;
    if (Array.isArray(result.data)) return;

    const continueStep = result.data.steps.find(
      (s) => typeof s !== "string" && /continue in iframe/i.test(s.step)
    );

    expect(continueStep).toBeDefined();
    if (!continueStep || typeof continueStep === "string") return;
    expect(continueStep.optional).toBe(false);
  });

  it("flags the resume step as an upload and keeps the final Submit step non-optional", () => {
    const result = RECON_FLOW_FILE_SCHEMA.safeParse(EXAMPLE_FLOW);

    expect(result.success).toBe(true);
    if (!result.success) return;
    if (Array.isArray(result.data)) return;

    const uploadStep = result.data.steps.find((s) => typeof s !== "string" && s.upload);
    const submitStep = result.data.steps.find((s) => typeof s !== "string" && s.submitStep);

    expect(uploadStep).toBeDefined();
    if (!uploadStep || typeof uploadStep === "string") return;
    expect(uploadStep.upload).toBe(true);

    expect(submitStep).toBeDefined();
    if (!submitStep || typeof submitStep === "string") return;
    expect(submitStep.optional).toBe(false);
  });

  it("runs the Submit step after the in-iframe Continue step", () => {
    const result = RECON_FLOW_FILE_SCHEMA.safeParse(EXAMPLE_FLOW);

    expect(result.success).toBe(true);
    if (!result.success) return;
    if (Array.isArray(result.data)) return;

    const steps = result.data.steps;
    const continueIndex = steps.findIndex(
      (s) => typeof s !== "string" && /continue in iframe/i.test(s.step)
    );
    const submitIndex = steps.findIndex((s) => typeof s !== "string" && s.submitStep);

    expect(continueIndex).toBeGreaterThanOrEqual(0);
    expect(submitIndex).toBeGreaterThanOrEqual(0);
    expect(continueIndex).toBeLessThan(submitIndex);
  });

  it("accepts a well-formed foldReturn declaration", () => {
    const flowWithFoldReturn = {
      ...EXAMPLE_FLOW,
      foldReturn: {
        endpointPattern: "/api/example/candidate-details",
        resultsPath: "data.results",
        joinField: "candidateId",
      },
    };

    const result = RECON_FLOW_FILE_SCHEMA.safeParse(flowWithFoldReturn);

    expect(result.success).toBe(true);
    if (!result.success) return;
    if (Array.isArray(result.data)) return;
    expect(result.data.foldReturn).toEqual(flowWithFoldReturn.foldReturn);
  });

  it("rejects a foldReturn declaration missing resultsPath", () => {
    const flowWithFoldReturnMissingResultsPath = {
      ...EXAMPLE_FLOW,
      foldReturn: {
        endpointPattern: "/api/example/candidate-details",
        joinField: "candidateId",
      },
    };

    const result = RECON_FLOW_FILE_SCHEMA.safeParse(flowWithFoldReturnMissingResultsPath);

    expect(result.success).toBe(false);
  });

  it("rejects a foldReturn declaration with a wrong-typed joinField", () => {
    const flowWithWrongTypedJoinField = {
      ...EXAMPLE_FLOW,
      foldReturn: {
        endpointPattern: "/api/example/candidate-details",
        resultsPath: "data.results",
        joinField: 42,
      },
    };

    const result = RECON_FLOW_FILE_SCHEMA.safeParse(flowWithWrongTypedJoinField);

    expect(result.success).toBe(false);
  });
});
