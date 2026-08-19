import { describe, expect, it } from "vitest";
import { firstEndpointPath } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

function makeCapture(overrides: Partial<Capture>): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "browse",
    method: "POST",
    url: "https://example.com/submit",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
    ...overrides,
  };
}

describe("firstEndpointPath fallback-template selection", () => {
  it("never resolves the single-endpoint fallback path to a leading GET landing-page capture", () => {
    const landingPage = makeCapture({
      method: "GET",
      status: 200,
      url: "https://example.com/CVS_Health_Careers/job/12345/apply",
    });
    const action = makeCapture({
      method: "POST",
      status: 200,
      url: "https://example.com/CVS_Health_Careers/job/12345/apply/submit",
    });

    const endpointPath = firstEndpointPath([landingPage, action]);

    expect(endpointPath).toBe("/CVS_Health_Careers/job/12345/apply/submit");
    expect(endpointPath).not.toBe(new URL(landingPage.url).pathname);
  });

  it("picks the first non-GET same-host action capture among several GET navigation captures", () => {
    const home = makeCapture({ method: "GET", url: "https://example.com/" });
    const landingPage = makeCapture({ method: "GET", url: "https://example.com/apply" });
    const patch = makeCapture({
      method: "PATCH",
      status: 200,
      url: "https://example.com/api/apply/step",
    });
    const submit = makeCapture({
      method: "POST",
      status: 200,
      url: "https://example.com/api/apply/submit",
    });

    expect(firstEndpointPath([home, landingPage, patch, submit])).toBe("/api/apply/step");
  });
});
