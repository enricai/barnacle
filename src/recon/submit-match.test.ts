import { describe, expect, it } from "vitest";
import { isQualifyingSubmitCapture } from "@/recon/submit-match";

const rx = /\/api\/orders/;
const hosts = ["shop.example.com"];

describe("isQualifyingSubmitCapture", () => {
  it("accepts a matching own-backend capture", () => {
    expect(
      isQualifyingSubmitCapture(
        { url: "https://shop.example.com/api/orders" },
        { endpointRx: rx, bodyRx: null, ownBackendHostnames: hosts }
      )
    ).toBe(true);
  });
  it("excludes a pattern match on an off-host capture", () => {
    expect(
      isQualifyingSubmitCapture(
        { url: "https://cdn.other.example.net/api/orders" },
        { endpointRx: rx, bodyRx: null, ownBackendHostnames: hosts }
      )
    ).toBe(false);
  });
  it("applies no host gate when the hostname list is empty", () => {
    expect(
      isQualifyingSubmitCapture(
        { url: "https://cdn.other.example.net/api/orders" },
        { endpointRx: rx, bodyRx: null, ownBackendHostnames: [] }
      )
    ).toBe(true);
  });
  it("rejects non-matching path and unparsable url", () => {
    const o = { endpointRx: rx, bodyRx: null, ownBackendHostnames: hosts };
    expect(isQualifyingSubmitCapture({ url: "https://shop.example.com/x" }, o)).toBe(false);
    expect(isQualifyingSubmitCapture({ url: "not a url" }, o)).toBe(false);
  });
});
