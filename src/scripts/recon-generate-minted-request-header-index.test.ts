import { describe, expect, it } from "vitest";
import { indexStateValues } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

const cap = (
  requestHeaders: Record<string, string>,
  responseHeaders: Record<string, string>
): Capture => ({
  timestamp: "2024-01-01T00:00:00Z",
  phase: "action",
  method: "POST",
  url: "https://shop.example.com/x",
  status: 200,
  requestHeaders,
  requestPostData: null,
  responseHeaders,
  responseBody: {},
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
});

describe("indexStateValues response-header minted then sent in request header", () => {
  it("indexes a response header value a later request sends verbatim", () => {
    const idx = indexStateValues([
      cap({}, { "x-csrf-token": "csrf_a1b2c3d4e5f6" }),
      cap({ "x-csrf-token": "csrf_a1b2c3d4e5f6" }, {}),
    ]);
    expect(idx.get("csrf_a1b2c3d4e5f6")?.headerOrigin).toEqual({ sourceHeader: "x-csrf-token" });
  });

  it("does not index a value no later request sends (falls through to false)", () => {
    const idx = indexStateValues([
      cap({}, { "x-csrf-token": "csrf_a1b2c3d4e5f6" }),
      cap({ "x-other": "different-value" }, {}),
    ]);
    expect(idx.has("csrf_a1b2c3d4e5f6")).toBe(false);
  });

  it("excludes constants already echoed in the origin's request (content-type style)", () => {
    const idx = indexStateValues([
      cap({ "content-type": "application/json" }, { "content-type": "application/json" }),
      cap({ "content-type": "application/json" }, {}),
    ]);
    expect(idx.has("application/json")).toBe(false);
  });
});
