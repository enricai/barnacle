import { expect, it } from "vitest";

import { isQualifyingSubmitCapture } from "@/recon/submit-match";

it("never counts a CORS preflight as a submission", () => {
  const opts = { endpointRx: /\/api\/search/, bodyRx: null, ownBackendHostnames: ["a.test"] };
  const qualifies = (method: string): boolean =>
    isQualifyingSubmitCapture({ method, url: "https://a.test/api/search" }, opts);
  expect(qualifies("OPTIONS")).toBe(false);
  expect(qualifies("POST")).toBe(true);
});
