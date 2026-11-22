import { describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";
import { firstEndpointCapture } from "./recon-generate.js";

const BASE = "https://shop.example.com";
const cap = (
  method: string,
  path: string,
  status: number,
  reqType: string,
  resType: string,
  post: string | null,
  body: unknown = null
): Capture =>
  ({
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method,
    url: `${BASE}${path}`,
    status,
    requestHeaders: { "Content-Type": reqType },
    requestPostData: post,
    responseHeaders: { "Content-Type": resType },
    responseBody: body,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  }) as unknown as Capture;

const FORM = "application/x-www-form-urlencoded";
const get = cap("GET", "/search?q=a", 200, "", "application/json", null, { results: [1] });

describe("firstEndpointCapture: form submits are not beacons", () => {
  it("keeps distinct-body 302 form POSTs as the primary endpoint", () => {
    const steps = [
      cap("POST", "/wizard", 302, FORM, "text/html", "step=1"),
      cap("POST", "/wizard", 302, FORM, "text/html", "step=2"),
    ];
    expect(firstEndpointCapture([get, ...steps])?.url).toBe(`${BASE}/wizard`);
  });

  it("keeps distinct-body text/html form POSTs", () => {
    const steps = [
      cap("POST", "/wizard", 200, FORM, "text/html", "step=1", "<p>a</p>"),
      cap("POST", "/wizard", 200, FORM, "text/html", "step=2", "<p>a</p>"),
    ];
    expect(firstEndpointCapture([get, ...steps])?.url).toBe(`${BASE}/wizard`);
  });

  it("still treats repeated text/plain POSTs with a fixed gif ack as a beacon", () => {
    const b = [
      cap("POST", "/px", 200, "text/plain", "image/gif", "a=1", "GIF89a"),
      cap("POST", "/px", 200, "text/plain", "image/gif", "a=2", "GIF89a"),
    ];
    expect(firstEndpointCapture([...b, get])?.method).toBe("GET");
  });
});
