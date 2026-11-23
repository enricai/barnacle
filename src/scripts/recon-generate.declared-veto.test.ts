import { describe, expect, it } from "vitest";
import { extractGraphQLActionSequence } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

function read(ts: string, operationName: string, body: unknown): Capture {
  return {
    timestamp: ts,
    phase: "action",
    method: "POST",
    url: "https://api.example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ operationName }),
    responseHeaders: {},
    operationName,
    query: `query ${operationName} { ${operationName} { id } }`,
    variables: null,
    responseBody: body,
    decodedParams: null,
  };
}

describe("declared selection is honored before the zero-variance veto", () => {
  it("keeps declared repeated same-URL reads instead of selecting 0", () => {
    const caps = [
      read("2026-01-01T00:00:00.000Z", "allSailings", { data: { items: [{ id: 1 }] } }),
      read("2026-01-01T00:00:01.000Z", "cabinCategoriesAvailability", { data: { id: 1 } }),
      read("2026-01-01T00:00:02.000Z", "cabinCategoriesAvailability", { data: { id: 1 } }),
    ];
    const kept = extractGraphQLActionSequence(
      caps,
      { endpoint: null, body: "allSailings|cabinCategoriesAvailability" },
      { endpointPattern: "/graphql", resultsPath: "data.items" }
    );
    expect(kept.length).toBeGreaterThanOrEqual(2);
  });
});
