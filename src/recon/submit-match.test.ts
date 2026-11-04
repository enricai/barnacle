import { describe, expect, it } from "vitest";
import { isQualifyingSubmitCapture, matchesSubmitPattern } from "@/recon/submit-match";

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

describe("matchesSubmitPattern", () => {
  it("never matches a data: URL containing the pattern text", () => {
    expect(matchesSubmitPattern({ url: "data:text/plain,/api/orders" }, rx, null)).toBe(false);
    expect(
      isQualifyingSubmitCapture(
        { url: "data:text/plain,/api/orders" },
        { endpointRx: rx, bodyRx: null, ownBackendHostnames: [] }
      )
    ).toBe(false);
  });
  it("matches a form-urlencoded body pattern on a generic domain", () => {
    const body = /ev=ViewContent/;
    const url = "https://track.example.com/collect";
    expect(
      matchesSubmitPattern({ url, requestPostData: "id=1&ev=ViewContent&x=2" }, /collect/, body)
    ).toBe(true);
    expect(matchesSubmitPattern({ url, requestPostData: "id=1&ev=Other" }, /collect/, body)).toBe(
      false
    );
    expect(matchesSubmitPattern({ url }, /collect/, body)).toBe(false);
  });
});
