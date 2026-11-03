import { describe, expect, it } from "vitest";
import { emitContractTs, emitIndexTs } from "@/scripts/recon-generate";

const OPTS = {
  siteId: "3dprint-shop",
  pascal: "_3dprintShop",
  baseUrl: "https://example.com",
  baseHeaders: {},
  minTime: 100,
  safeRps: 10,
  responseBody: { ok: true },
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/example",
  auxFiles: [],
};

describe("digit-leading site id camel identifiers", () => {
  it("emitIndexTs exports a valid identifier", () => {
    const src = emitIndexTs({ siteId: "3dprint-shop", pascal: "_3dprintShop" });
    expect(src).toContain("export { _3dprintShopPlugin, _3dprintShopPlugin as plugin }");
  });
  it("emitContractTs emits the same valid identifier", () => {
    const src = emitContractTs(OPTS as never);
    expect(src).toContain("_3dprintShopPlugin");
    expect(src).not.toMatch(/\b3dprintShopPlugin\b/);
  });
});
