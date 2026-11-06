import { describe, expect, it } from "vitest";

import { emitBrowserFlowTs } from "@/scripts/recon-generate";

describe("emitBrowserFlowTs — payload-driven read fallback", () => {
  const { code } = emitBrowserFlowTs({
    siteId: "travel-fixture",
    pascal: "TravelFixture",
    baseUrl: "https://flights.example.com",
    flowSteps: [
      {
        step: "Open the flights list",
        navigateTo: "https://flights.example.com/search#/dest/paris",
        payloadField: "Destination",
      },
    ],
    isSubmissionFlow: false,
    readOnlyGetFlow: true,
    getInputFields: ["Destination"],
  });

  it("splices the payload field into the navigateTo URL", () => {
    expect(code).toContain("encodeURIComponent(String(payload.Destination))");
    expect(code).not.toContain("paris");
  });
  it("has no hard-coded recon URL and no payload.query", () => {
    expect(code).not.toContain("https://flights.example.com");
    expect(code).not.toContain("payload.query");
  });

  it("rebases a field-less read-only navigateTo onto the runtime baseUrl origin", () => {
    const { code: c } = emitBrowserFlowTs({
      siteId: "travel-fixture",
      pascal: "TravelFixture",
      baseUrl: "https://flights.example.com",
      flowSteps: [{ step: "Open home", navigateTo: "https://flights.example.com/deals?a=1" }],
      isSubmissionFlow: false,
      readOnlyGetFlow: true,
      getInputFields: [],
    });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal interpolation text in generated plugin source
    expect(c).toContain("navigateTo: `${new URL(baseUrl).origin}/deals?a=1`");
    expect(c).not.toContain("https://flights.example.com/deals");
  });
  it("keeps a non-read-only navigateTo as a plain literal URL", () => {
    const { code: c } = emitBrowserFlowTs({
      siteId: "travel-fixture",
      pascal: "TravelFixture",
      baseUrl: "https://flights.example.com",
      flowSteps: [{ step: "Open home", navigateTo: "https://flights.example.com/deals" }],
      isSubmissionFlow: true,
      readOnlyGetFlow: false,
    });
    expect(c).toContain('navigateTo: "https://flights.example.com/deals"');
  });
});
