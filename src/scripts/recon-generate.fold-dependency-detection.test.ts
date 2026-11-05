import { describe, expect, it } from "vitest";
import {
  collectRequestValuesIncludingHeaders,
  collectResponseLeafValues,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-generate";

function cap(over: Record<string, unknown>): Capture {
  return {
    url: "https://x.test/a",
    method: "POST",
    requestHeaders: {},
    responseHeaders: {},
    requestPostData: null,
    responseBody: {},
    ...over,
  } as unknown as Capture;
}

describe("fold dependency value detection", () => {
  it("ignores cookie and content-type header values", () => {
    const c = cap({
      requestHeaders: { Cookie: "sess=abc12345", "Content-Type": "application/json" },
      responseHeaders: { "set-cookie": "sess=abc12345", "content-type": "application/json" },
    });
    expect(collectRequestValuesIncludingHeaders(c).has("sess=abc12345")).toBe(false);
    expect(collectResponseLeafValues(c).has("application/json")).toBe(false);
  });
  it("keeps custom minted header tokens", () => {
    const c = cap({ requestHeaders: { "X-Price-Token": "tok-a1" } });
    expect(collectRequestValuesIncludingHeaders(c).has("tok-a1")).toBe(true);
  });
});
