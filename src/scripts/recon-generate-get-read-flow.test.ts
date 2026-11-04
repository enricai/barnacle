import { describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";
import { firstEndpointCapture } from "./recon-generate.js";

const cap = (url: string, status: number, method = "GET"): Capture =>
  ({ url, method, status, responseBody: {}, requestHeaders: {} }) as unknown as Capture;

describe("firstEndpointCapture — read-only GET flow", () => {
  it("picks the first successful own-backend GET over an earlier failed one", () => {
    const failed = cap("https://api.example.com/missing", 404);
    const ok = cap("https://api.example.com/items/1", 200);
    expect(firstEndpointCapture([failed, ok], ["api.example.com"])).toBe(ok);
  });
  it("still prefers a non-GET capture when present", () => {
    const get = cap("https://api.example.com/items/1", 200);
    const post = cap("https://api.example.com/submit", 200, "POST");
    expect(firstEndpointCapture([get, post], ["api.example.com"])).toBe(post);
  });
});
