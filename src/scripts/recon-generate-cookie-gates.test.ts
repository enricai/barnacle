import { describe, expect, it } from "vitest";

import {
  collectHeaderBindings,
  emitContractTs,
  walkSetCookiePairs,
} from "@/scripts/recon-generate";

/** Minimal opts that satisfy emitContractTs for a non-multipart plugin —
 * mirrors recon-generate.test.ts's BASE_OPTS so the rendered bind literal
 * assertion below matches the shape the CLI actually emits. */
const BASE_OPTS = {
  siteId: "disneycruise",
  pascal: "Disneycruise",
  baseUrl: "https://api.example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { products: [] },
  gql: false,
  gqlQuery: null,
  endpointPath: "/dcl-apps-productavail-vas/available-products/",
  auxFiles: [],
};

describe("walkSetCookiePairs — newline-folded multi-cookie Set-Cookie strings", () => {
  it("yields every cookie in a newline-joined 7-cookie string, including one buried mid-string", () => {
    const rawSetCookie = [
      "ADRUM_BTa=R:0|g:abc123; Path=/; HttpOnly",
      "ADRUM_BTa=R:1|g:def456; Path=/; HttpOnly",
      "ADRUM_BT1=R:0; Path=/",
      "ADRUM_BT1=R:1; Path=/",
      "ADRUM_BT1=R:2; Path=/",
      "__pa=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP; Path=/; HttpOnly; Secure",
      "bm_sv=ABCDEF1234567890; Path=/; HttpOnly; Secure",
    ].join("\n");

    const pairs = [...walkSetCookiePairs(rawSetCookie)];

    expect(pairs).toHaveLength(7);
    expect(pairs.map((p) => p.name)).toEqual([
      "ADRUM_BTa",
      "ADRUM_BTa",
      "ADRUM_BT1",
      "ADRUM_BT1",
      "ADRUM_BT1",
      "__pa",
      "bm_sv",
    ]);
    expect(pairs.find((p) => p.name === "__pa")?.value).toBe(
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP"
    );
  });

  it("yields exactly one pair for a single-cookie string, with attributes stripped", () => {
    const pairs = [...walkSetCookiePairs("session=tok123; Path=/; HttpOnly; Secure")];
    expect(pairs).toEqual([{ name: "session", value: "tok123" }]);
  });

  it("skips a newline entry with no '=' instead of aborting the remaining entries", () => {
    const rawSetCookie = ["malformed-entry-no-equals", "session=tok123; Path=/"].join("\n");
    const pairs = [...walkSetCookiePairs(rawSetCookie)];
    expect(pairs).toEqual([{ name: "session", value: "tok123" }]);
  });
});

describe("collectHeaderBindings — multi-cookie Cookie target (disneycruise __pa report)", () => {
  /** step 0: toggles/product-avail — surfaces three geo/toggle cookies plus one
   * non-cookie header produce, in recon order. */
  const productAvailStep = {
    capture: {} as never,
    varName: "r0",
    produces: [
      {
        kind: "header",
        name: "conversationUuidHeader",
        sourceHeader: "x-conversation-id",
        targetHeader: "X-Conversation-Id",
      },
      {
        kind: "header",
        name: "latestWdproGeoIpCookie",
        sourceHeader: "set-cookie",
        cookieName: "latestWDPROGeoIP",
        targetHeader: "Cookie",
      },
      {
        kind: "header",
        name: "wdproGeoIpCookie",
        sourceHeader: "set-cookie",
        cookieName: "WDPROGeoIP",
        targetHeader: "Cookie",
      },
      {
        kind: "header",
        name: "bmSvCookie",
        sourceHeader: "set-cookie",
        cookieName: "bm_sv",
        targetHeader: "Cookie",
      },
    ],
    isMultipart: false,
    isCrossDomain: false,
  };

  /** step 1: authz/private — mints the load-bearing __pa session cookie, last
   * in recon order among the four Cookie-targeting produces. */
  const authzPrivateStep = {
    capture: {} as never,
    varName: "r1",
    produces: [
      {
        kind: "header",
        name: "paCookie",
        sourceHeader: "set-cookie",
        cookieName: "__pa",
        targetHeader: "Cookie",
      },
    ],
    isMultipart: false,
    isCrossDomain: false,
  };

  const bindings = collectHeaderBindings([productAvailStep, authzPrivateStep] as never);

  it("keeps every distinct cookie-origin produce targeting Cookie, including the last-produced __pa", () => {
    const cookieNames = bindings
      .filter((b) => b.targetHeader === "Cookie")
      .map((b) => b.cookieName)
      .sort();
    expect(cookieNames).toEqual(["WDPROGeoIP", "__pa", "bm_sv", "latestWDPROGeoIP"].sort());
  });

  it("still dedupes the non-cookie X-Conversation-Id target to a single binding", () => {
    const conversationBindings = bindings.filter((b) => b.targetHeader === "X-Conversation-Id");
    expect(conversationBindings).toHaveLength(1);
    expect(conversationBindings[0]?.name).toBe("conversationUuidHeader");
  });

  it("returns exactly five bindings total — four Cookie-origin plus one non-cookie", () => {
    expect(bindings).toHaveLength(5);
  });

  it("bindOptionLiteral renders __pa alongside the other three Cookie-origin cookies in the emitted contract, pinning the disneycruise report's exact ordering (__pa produced last)", () => {
    const contract = emitContractTs({
      ...BASE_OPTS,
      inputBody: {},
      multiStepBody: "    return { data: {} as unknown };",
      headerBindings: bindings as never,
    });

    expect(contract).toContain('cookieName: "__pa"');
    expect(contract).toContain('cookieName: "latestWDPROGeoIP"');
    expect(contract).toContain('cookieName: "WDPROGeoIP"');
    expect(contract).toContain('cookieName: "bm_sv"');
  });

  /** step 2: a later capture re-produces latestWDPROGeoIP under 'cookie'
   * (lowercase, as compileActionSteps derives targetHeader verbatim from the
   * observed request-header casing) while step 0's produce above used 'Cookie'.
   * Both produces carry the SAME cookieName — a correct emitter must treat
   * them as one logical binding, not two. A duplicated non-cookie header
   * ('X-Conversation-Id' vs 'x-conversation-id') is mixed in too, pinning
   * that casing collisions collapse for BOTH shapes. */
  const casingVariantStep = {
    capture: {} as never,
    varName: "r2",
    produces: [
      {
        kind: "header",
        name: "latestWdproGeoIpCookieLower",
        sourceHeader: "set-cookie",
        cookieName: "latestWDPROGeoIP",
        targetHeader: "cookie",
      },
      {
        kind: "header",
        name: "conversationUuidHeaderLower",
        sourceHeader: "x-conversation-id",
        targetHeader: "x-conversation-id",
      },
    ],
    isMultipart: false,
    isCrossDomain: false,
  };

  const bindingsWithCasingVariants = collectHeaderBindings([
    productAvailStep,
    authzPrivateStep,
    casingVariantStep,
  ] as never);

  it("does not split one logical cookie target across casings — the same cookieName produced under 'Cookie' and 'cookie' emits only one binding", () => {
    const latestGeoIpBindings = bindingsWithCasingVariants.filter(
      (b) => b.cookieName === "latestWDPROGeoIP"
    );
    expect(latestGeoIpBindings).toHaveLength(1);
  });

  it("groups every cookie-origin binding under one targetHeader.toLowerCase() bucket, so the emitted contract cannot contain two case-variant Cookie targets", () => {
    const cookieGroups = new Set(
      bindingsWithCasingVariants
        .filter((b) => b.cookieName !== undefined)
        .map((b) => b.targetHeader.toLowerCase())
    );
    expect(cookieGroups.size).toBe(1);
  });

  it("still surfaces the load-bearing __pa cookie once the lowercase 'cookie' target is mixed in", () => {
    const cookieNames = bindingsWithCasingVariants
      .filter((b) => b.cookieName !== undefined)
      .map((b) => b.cookieName);
    expect(cookieNames).toContain("__pa");
  });

  it("collapses a duplicated non-cookie target differing only by case ('X-Conversation-Id' vs 'x-conversation-id') to a single binding", () => {
    const conversationBindings = bindingsWithCasingVariants.filter(
      (b) => b.targetHeader.toLowerCase() === "x-conversation-id"
    );
    expect(conversationBindings).toHaveLength(1);
  });
});
