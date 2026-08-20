import { describe, expect, it } from "vitest";

import { emitBrowserFlowTs, emitConfigManifest, emitContractTs } from "@/scripts/recon-generate";

/**
 * Regression coverage: a submission flow's final emitted step must be marked
 * submitStep:true (even when the source recon-flow.json step never declared
 * it) so the engine's pre-submit probe/StepVerificationError actually gates
 * it, and the emitted response schema must expose a real `verified` field
 * instead of a TODO/z.unknown() placeholder once that verification exists.
 */
describe("recon-generate — submit-step verification", () => {
  const submissionOpts = {
    siteId: "recon-site-3",
    pascal: "ReconSite3",
    baseUrl: "https://careers.example.org",
    isSubmissionFlow: true,
    flowSteps: [
      "Click the First Name field and type John",
      "Click the Last Name field and type Doe",
      "Click the Submit Application button",
    ],
  };

  it("forces submitStep:true on the LAST emitted step even when the source step never declared it", () => {
    const { code } = emitBrowserFlowTs(submissionOpts);
    const stepLines = code.split("\n").filter((line) => line.trim().startsWith("{ instruction:"));

    expect(stepLines).toHaveLength(3);
    expect(stepLines[0]).toContain("submitStep: false");
    expect(stepLines[1]).toContain("submitStep: false");
    expect(stepLines[2]).toContain("submitStep: true");
  });

  it("keeps an explicitly-authored earlier submitStep:false untouched and only forces the LAST step", () => {
    const { code } = emitBrowserFlowTs({
      ...submissionOpts,
      flowSteps: [
        { step: "Click the First Name field and type John", submitStep: false },
        "Click the Submit Application button",
      ],
    });
    const stepLines = code.split("\n").filter((line) => line.trim().startsWith("{ instruction:"));

    expect(stepLines).toHaveLength(2);
    expect(stepLines[0]).toContain("submitStep: false");
    expect(stepLines[1]).toContain("submitStep: true");
  });

  it("does NOT force submitStep on a non-submission (query) flow's last step", () => {
    const { code } = emitBrowserFlowTs({ ...submissionOpts, isSubmissionFlow: false });
    const stepLines = code.split("\n").filter((line) => line.trim().startsWith("{ instruction:"));

    expect(stepLines.at(-1)).toContain("submitStep: false");
  });

  it("emits a real `verified: z.boolean()` field on the BrowserSchema for a submission flow, not the extraction TODO", () => {
    const { code } = emitBrowserFlowTs(submissionOpts);

    expect(code).toContain("verified: z.boolean()");
    expect(code).not.toContain("extraction: z.string()");
  });

  it("sets the runtime return value's verified field to true — the successful runHealingFlow call is the proof", () => {
    const { code } = emitBrowserFlowTs(submissionOpts);

    expect(code).toContain("{ ...result, verified: true }");
  });

  it("validates a non-submission browser flow against the contract's ResponseSchema, not a placeholder", () => {
    const { code } = emitBrowserFlowTs({ ...submissionOpts, isSubmissionFlow: false });

    expect(code).not.toContain("extraction: z.string()");
    expect(code).not.toContain("verified: z.boolean()");
    expect(code).toContain(`${submissionOpts.pascal}ResponseSchema`);
  });

  const contractOpts = {
    siteId: "recon-site-3",
    pascal: "ReconSite3",
    baseUrl: "https://careers.example.org",
    baseHeaders: {},
    minTime: 100,
    safeRps: 10,
    responseBody: { ok: true },
    gql: false,
    gqlQuery: null,
    endpointPath: "/apply",
    auxFiles: [],
    inputBody: { FirstName: "John" },
    omitExecuteHttp: true,
  };

  it("emitContractTs emits a real `verified: z.boolean()` response schema for a submission, browser-only flow", () => {
    const source = emitContractTs({ ...contractOpts, isSubmissionFlow: true });

    expect(source).toContain("z.object({ verified: z.boolean() })");
    expect(source).not.toContain("const ReconSite3ResponseSchema = z.unknown();");
  });

  it("keeps the honest-gap z.unknown() for a non-submission, browser-only flow", () => {
    const source = emitContractTs({ ...contractOpts, isSubmissionFlow: false });

    expect(source).toContain("const ReconSite3ResponseSchema = z.unknown();");
  });

  it("keeps the honest-gap z.unknown() when isSubmissionFlow is omitted (defaults to false)", () => {
    const source = emitContractTs(contractOpts);

    expect(source).toContain("const ReconSite3ResponseSchema = z.unknown();");
  });

  it("never emits submitEndpointPattern regardless of input — no key is written without measured submittedStateSelectors", () => {
    const manifest = emitConfigManifest({
      siteId: "recon-site-3",
      displayName: "Recon Site 3",
      baseUrl: "https://careers.example.org",
      flowSteps: submissionOpts.flowSteps,
      inputBody: { FirstName: "John" },
    });

    expect(manifest).not.toContain("submitEndpointPattern");
  });

  it("emitConfigManifest also forces submitStep:true on the last step for a submission flow — the config-plugin runtime gates on the same field", () => {
    const manifest = emitConfigManifest({
      siteId: "recon-site-3",
      displayName: "Recon Site 3",
      baseUrl: "https://careers.example.org",
      flowSteps: submissionOpts.flowSteps,
      inputBody: { FirstName: "John" },
      isSubmissionFlow: true,
    });
    const steps = JSON.parse(manifest).spec.flow.steps;

    expect(steps).toHaveLength(3);
    expect(steps[0]).not.toHaveProperty("submitStep");
    expect(steps[1]).not.toHaveProperty("submitStep");
    expect(steps.at(-1)).toMatchObject({ submitStep: true });
  });

  it("does NOT force submitStep on emitConfigManifest's last step when isSubmissionFlow is omitted", () => {
    const manifest = emitConfigManifest({
      siteId: "recon-site-3",
      displayName: "Recon Site 3",
      baseUrl: "https://careers.example.org",
      flowSteps: submissionOpts.flowSteps,
      inputBody: { FirstName: "John" },
    });
    const steps = JSON.parse(manifest).spec.flow.steps;

    expect(steps.at(-1)).not.toHaveProperty("submitStep");
  });
});
