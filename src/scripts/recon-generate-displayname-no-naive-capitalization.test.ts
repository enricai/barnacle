import { describe, expect, it } from "vitest";

import { emitContractTs } from "@/scripts/recon-generate";

/** Minimal opts that satisfy the emitter for a non-multipart plugin. Matches
 * BASE_OPTS in recon-generate-bind-literal.test.ts, but with a multi-word
 * PascalCase siteId chosen specifically to expose naive capitalization: the
 * regex-based `${pascal.replace(/([A-Z])/g, " $1").trim()}` transform would
 * mangle this into "Wholesale Fish Market", which no capture ever observed. */
const BASE_OPTS = {
  siteId: "wholesale-fish-market",
  pascal: "WholesaleFishMarket",
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

describe("emitContractTs — meta.displayName is not derived by naive siteId capitalization", () => {
  it("never emits a displayName split from the PascalCase siteId", () => {
    const contract = emitContractTs(BASE_OPTS);
    expect(contract).not.toContain(`displayName: "Wholesale Fish Market"`);
  });

  it("omits displayName from the meta block entirely", () => {
    const contract = emitContractTs(BASE_OPTS);
    const metaBlockMatch = contract.match(/meta: \{[\s\S]*?\n {2}\},/);
    expect(metaBlockMatch).not.toBeNull();
    expect(metaBlockMatch?.[0]).not.toContain("displayName");
  });
});
