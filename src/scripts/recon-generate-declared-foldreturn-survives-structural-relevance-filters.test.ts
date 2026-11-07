import { describe, expect, it } from "vitest";

import {
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  type SubmitPatterns,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

const HOST = "api.example.com";

function cap(path: string, mutation: boolean, body: unknown): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "action",
    method: "POST",
    url: `https://${HOST}${path}`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: "{}",
    responseHeaders: {},
    operationName: "Op",
    query: mutation ? "mutation Op { op { id } }" : "query Op { op { id } }",
    variables: null,
    responseBody: body,
    decodedParams: null,
  };
}

const SUBMIT: SubmitPatterns = { endpoint: "/(catalog|reviews|unrelated)", body: null };
const FOLD: FoldReturnSpec = {
  endpointPattern: "/reviews",
  resultsPath: "items",
  joinFields: ["id"],
} as unknown as FoldReturnSpec;

describe("declared foldReturn drill survives the mutation-path structural filter", () => {
  it("keeps a declared drill sharing no path token and drops an undeclared unrelated capture", () => {
    const mutation = cap("/catalog/search", true, { items: [{ id: 1 }] });
    const drill = cap("/reviews", false, [{ id: 1 }]);
    const noise = cap("/unrelated", false, { x: 1 });
    const out = extractGraphQLActionSequence(
      [mutation, drill, noise],
      SUBMIT,
      FOLD,
      [],
      "example.com",
      HOST
    ).map((a) => a.capture.url);
    expect(out).toContain(`https://${HOST}/reviews`);
    expect(out).not.toContain(`https://${HOST}/unrelated`);
  });
});
