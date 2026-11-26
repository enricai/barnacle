import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

const gen = (hasMultipartStep: boolean) =>
  emitContractTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://api.example.test",
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: { ok: true },
    gql: false,
    gqlQuery: null,
    endpointPath: "/cart",
    auxFiles: [],
    isSubmissionFlow: true,
    inputBody: { cart: { items_attributes: [{ roomId: 9, playersCount: 2 }] } },
    discoveredFormFields: new Set(),
    discoveredAdditionalBodyKeys: new Map(),
    discoveredStructuredKeys: new Map([["items_attributes", "z.array(z.object({ roomId: z.number() }))"]]),
    discoveredRawOptionFields: new Map(),
    payloadFieldNames: new Set(),
    hasMultipartStep,
  } as never);

describe("multipart is derived from wire encoding", () => {
  it("all-JSON capture with a nested array emits no multipart", () => {
    const src = gen(false);
    expect(src).not.toMatch(/multipart: true/);
    expect(src).not.toContain("multipartJsonObject(");
  });
  it("genuine multipart capture still emits multipart: true", () => {
    expect(gen(true)).toMatch(/multipart: true/);
  });
});
