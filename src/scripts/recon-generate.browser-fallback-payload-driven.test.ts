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
});
