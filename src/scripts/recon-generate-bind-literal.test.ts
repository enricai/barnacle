import { describe, expect, it } from "vitest";

import { emitContractTs } from "@/scripts/recon-generate";

/** Minimal opts that satisfy the emitter for a non-multipart plugin. Mirrors
 * BASE_OPTS in recon-generate.test.ts — kept separate per that file's own
 * fixture rather than imported, so this file stays disjoint from the capture
 * chain the sibling suite exercises. */
const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { id: "abc", active: true },
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/search",
  auxFiles: [],
};

describe("bindOptionLiteral (via emitContractTs) — cookie vs non-cookie bindings", () => {
  const COOKIE_NAMES = ["latestWDPROGeoIP", "WDPROGeoIP", "bm_sv", "__pa"];

  const cookieBindings = COOKIE_NAMES.map((cookieName) => ({
    kind: "header" as const,
    name: cookieName,
    sourceHeader: "set-cookie",
    cookieName,
    targetHeader: "Cookie",
  }));

  const conversationIdBinding = {
    kind: "header" as const,
    name: "conversationId",
    sourceHeader: "x-conversation-id",
    targetHeader: "X-Conversation-Id",
  };

  const contract = emitContractTs({
    ...BASE_OPTS,
    headerBindings: [...cookieBindings, conversationIdBinding],
  });

  it("renders one bind entry per cookie binding, each with its cookieName field", () => {
    for (const cookieName of COOKIE_NAMES) {
      expect(contract).toContain(
        `{ sourceHeader: "set-cookie", cookieName: "${cookieName}", targetHeader: "Cookie" }`
      );
    }
  });

  it("renders the non-cookie X-Conversation-Id entry without a cookieName field", () => {
    expect(contract).toContain(
      '{ sourceHeader: "x-conversation-id", targetHeader: "X-Conversation-Id" }'
    );
    expect(contract).not.toContain('sourceHeader: "x-conversation-id", cookieName:');
  });

  it("still contains the bind: [ ... ] wrapper the entries live inside", () => {
    expect(contract).toMatch(/bind: \[.*\]/);
  });
});

describe("bindOptionLiteral (via emitContractTs) — empty headerBindings", () => {
  it("emits no bind: fragment at all when headerBindings is an empty array", () => {
    const contract = emitContractTs({ ...BASE_OPTS, headerBindings: [] });
    expect(contract).not.toContain("bind:");
  });

  it("emits the same createHttpClient call as when headerBindings is omitted entirely", () => {
    const withEmptyArray = emitContractTs({ ...BASE_OPTS, headerBindings: [] });
    const withOmittedOption = emitContractTs({ ...BASE_OPTS });
    expect(withEmptyArray).toEqual(withOmittedOption);
  });
});
