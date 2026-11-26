import { describe, expect, it } from "vitest";

import { emitBrowserFlowTs, emitIndexTs } from "@/scripts/recon-generate";

const base = {
  siteId: "s",
  pascal: "S",
  baseUrl: "https://example.com",
  isSubmissionFlow: false,
};
const steps = ["click the login button", "click the next button"];

describe("empty mixed tail", () => {
  it("emits a handover-only flow", () => {
    const { code } = emitBrowserFlowTs({
      ...base,
      flowSteps: steps,
      mixedHandover: { tailFromStep: steps.length },
    });
    expect(code).toContain("sessionCookies");
    expect(code).not.toContain("executeHttp throws");
    expect(code).not.toContain("TODO: no flow steps were parsed");
    expect(code).not.toContain("payload");
    expect(code).not.toContain("guardedExtract");
    expect(code).not.toContain("extract");
  });
  it("leaves a non-empty tail unchanged", () => {
    const { code } = emitBrowserFlowTs({
      ...base,
      flowSteps: steps,
      mixedHandover: { tailFromStep: 1 },
    });
    expect(code).toContain("executeHttp throws");
    expect(code).toContain("guardedExtract");
  });
  it("index header for a mixed flow does not say to load alone", () => {
    const mixed = emitIndexTs({ siteId: "s", pascal: "S", mixedHandover: true });
    expect(mixed).toContain("do not load this module alone");
    expect(mixed).not.toContain("BARNACLE_PLUGINS=./dist");
    expect(emitIndexTs({ siteId: "s", pascal: "S" })).toContain("BARNACLE_PLUGINS=./dist");
  });
});
