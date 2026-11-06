import { describe, expect, it } from "vitest";

import {
  extractActionSequence,
  type FoldReturnSpec,
  type SubmitPatterns,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

const HOST = "api.example.com";

function cap(method: string, path: string, body: unknown): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "action",
    method,
    url: `https://${HOST}${path}`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: method === "POST" ? "{}" : null,
    responseHeaders: {},
    operationName: null,
    query: null,
    variables: null,
    responseBody: body,
    decodedParams: null,
  } as unknown as Capture;
}

const SUBMIT: SubmitPatterns = { endpoint: "/catalog/search", body: null };
const FOLD = {
  endpointPattern: "/reviews",
  resultsPath: "items",
  joinFields: ["id"],
} as unknown as FoldReturnSpec;

describe("final anchor narrowing keeps declared authoritative captures", () => {
  it("keeps a declared foldReturn drill sharing no token with the submit endpoint", () => {
    const out = extractActionSequence(
      [
        cap("POST", "/catalog/search", { items: [{ id: 1 }] }),
        cap("GET", "/reviews", [{ id: 1 }]),
      ],
      SUBMIT,
      FOLD,
      [HOST]
    ).map((a) => a.capture.url);
    expect(out).toContain(`https://${HOST}/catalog/search`);
    expect(out).toContain(`https://${HOST}/reviews`);
  });
});
