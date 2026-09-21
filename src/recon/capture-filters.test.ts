import { afterEach, describe, expect, it } from "vitest";

import {
  ERROR_SINK_PATH_SEGMENT,
  isNoiseUrl,
  isSamePathFamily,
  isStructurallyIsolatedCapture,
  isStructurallyRelevantCapture,
  isZeroVarianceRepeatCapture,
  telemetryUrlPatterns,
} from "@/recon/capture-filters";

const originalTelemetryEnv = process.env.RECON_TELEMETRY_URL_PATTERNS;

afterEach(() => {
  if (originalTelemetryEnv === undefined) delete process.env.RECON_TELEMETRY_URL_PATTERNS;
  else process.env.RECON_TELEMETRY_URL_PATTERNS = originalTelemetryEnv;
});

describe("isNoiseUrl — third-party asset/telemetry hosts", () => {
  it("skips the ad-tech and session-replay hosts recon wastes time on", () => {
    expect(isNoiseUrl("https://x.clicktale.net/collect")).toBe(true);
    expect(isNoiseUrl("https://sync.adsrvr.org/track")).toBe(true);
    expect(isNoiseUrl("https://analytics.tiktok.com/api/v2/pixel")).toBe(true);
    expect(isNoiseUrl("https://connect.facebook.net/en_US/fbevents.js")).toBe(true);
  });

  it("keeps the site's own API endpoint", () => {
    expect(isNoiseUrl("https://apply.acme.example/listings-apps/available-products/")).toBe(false);
  });

  it("skips a same-host error-reporting sink but keeps data endpoints that spell 'error'", () => {
    expect(isNoiseUrl("https://apply.acme.example/listings-spa/error")).toBe(true);
    expect(isNoiseUrl("https://apply.acme.example/api/error-codes")).toBe(false);
    expect(isNoiseUrl("https://apply.acme.example/api/terrorism-screening")).toBe(false);
  });

  it("skips static assets served under the site host", () => {
    expect(isNoiseUrl("https://apply.acme.example/static/main.js")).toBe(true);
    expect(isNoiseUrl("https://apply.acme.example/assets/logo.png")).toBe(true);
  });

  it("does not throw on an unparseable url", () => {
    expect(isNoiseUrl("not a url")).toBe(false);
  });
});

describe("telemetryUrlPatterns — env seam read at call time", () => {
  it("includes RECON_TELEMETRY_URL_PATTERNS additions set after import", () => {
    process.env.RECON_TELEMETRY_URL_PATTERNS = "parksmedia,my-tracker.example";
    const patterns = telemetryUrlPatterns();
    expect(patterns).toContain("parksmedia");
    expect(patterns).toContain("my-tracker.example");
    expect(isNoiseUrl("https://apply.acme.example/parksmedia/asset")).toBe(true);
  });
});

describe("isStructurallyRelevantCapture", () => {
  const referencePaths = ["/booking-apps-productavail-vas/v1/search"];

  it("rejects a same-host capture that shares nothing but the host", () => {
    expect(isStructurallyRelevantCapture("/marketing/api/promotions/widget", referencePaths)).toBe(
      false
    );
  });

  it("accepts a different-but-related endpoint family within the same flow", () => {
    expect(
      isStructurallyRelevantCapture(
        "/booking-apps-sailingavailability-vas/v1/search",
        referencePaths
      )
    ).toBe(true);
  });

  it("accepts a candidate that exactly matches a reference path prefix", () => {
    expect(
      isStructurallyRelevantCapture(
        "/booking-apps-productavail-vas/v1/search/detail",
        referencePaths
      )
    ).toBe(true);
  });

  it("rejects a same-host capture that only shares a common plain-word segment, not a family identifier", () => {
    expect(isStructurallyRelevantCapture("/marketing/api/promotions/search", referencePaths)).toBe(
      false
    );
    expect(
      isStructurallyRelevantCapture("/site-banner/api/promotions/widget", [
        "/booking-apps-productavail-vas/v1/detail",
      ])
    ).toBe(false);
  });
});

describe("isStructurallyIsolatedCapture", () => {
  const poolPaths = [
    "/booking-apps-productavail-vas/v1/search",
    "/booking-apps-sailingavailability-vas/v1/search",
  ];

  it("flags a compound-path capture that shares no token with any pool member", () => {
    expect(isStructurallyIsolatedCapture("/marketing-api/promotions-widget", poolPaths)).toBe(true);
  });

  it("does not flag a capture related to at least one pool member", () => {
    expect(
      isStructurallyIsolatedCapture("/booking-apps-productavail-vas/v1/detail", poolPaths)
    ).toBe(false);
  });

  it("never flags a plain single-word path, even if it shares no token with the pool", () => {
    expect(isStructurallyIsolatedCapture("/applicant", poolPaths)).toBe(false);
  });

  it("never flags a short two-segment all-single-word path, even if it shares no segment with the pool", () => {
    expect(isStructurallyIsolatedCapture("/sections/name", poolPaths)).toBe(false);
  });

  it("flags a same-host all-single-word-segment path that shares no segment with the pool", () => {
    expect(isStructurallyIsolatedCapture("/catalog/api/deals/catalog/default", poolPaths)).toBe(
      true
    );
  });

  it("does not flag an all-single-word-segment path that shares a meaningful raw segment with the pool", () => {
    expect(isStructurallyIsolatedCapture("/v1/search/other", poolPaths)).toBe(false);
  });

  it("still flags an isolated all-single-word-segment path that only shares a generic segment like 'api'", () => {
    expect(
      isStructurallyIsolatedCapture("/catalog/api/deals/catalog/default", [
        "/site/api/booking/search",
      ])
    ).toBe(true);
  });

  it("never flags a deeper all-single-word chain step with no repeated segment, even if it shares no segment with the pool", () => {
    expect(isStructurallyIsolatedCapture("/user/profile/edit", ["/checkout/confirm"])).toBe(false);
  });

  it("flags a same-host all-single-word path with a repeated segment even at only 3 segments deep", () => {
    expect(isStructurallyIsolatedCapture("/catalog/promotions/catalog", poolPaths)).toBe(true);
  });

  it("flags a same-host all-single-word-segment path with a repeated segment against an unrelated pool", () => {
    expect(isStructurallyIsolatedCapture("/widgets/offers/widgets", poolPaths)).toBe(true);
  });

  it("still flags both same-family noise variants when two co-occur in the same pool, instead of mutually vouching for each other", () => {
    const poolWithBothNoiseVariants = [
      ...poolPaths,
      "/catalog/api/deals/catalog/default",
      "/catalog/api/deals/catalog",
    ];
    expect(
      isStructurallyIsolatedCapture("/catalog/api/deals/catalog/default", poolWithBothNoiseVariants)
    ).toBe(true);
    expect(
      isStructurallyIsolatedCapture("/catalog/api/deals/catalog", poolWithBothNoiseVariants)
    ).toBe(true);
  });
});

describe("isSamePathFamily", () => {
  it("matches two self-referential paths sharing a repeated segment, with no compound token overlap", () => {
    expect(
      isSamePathFamily("/catalog/api/deals/catalog", "/catalog/api/deals/catalog/default")
    ).toBe(true);
  });

  it("matches on compound-segment token overlap when both paths have one", () => {
    expect(
      isSamePathFamily(
        "/booking-apps-productavail-vas/v1/search",
        "/booking-apps-sailingavailability-vas/v1/detail"
      )
    ).toBe(true);
  });

  it("rejects two unrelated plain-word paths with no repeated segment and no compound token", () => {
    expect(isSamePathFamily("/applicant", "/sections/name")).toBe(false);
  });

  it("rejects a self-referential path against a plain chain step it shares no segment with", () => {
    expect(isSamePathFamily("/catalog/api/deals/catalog", "/checkout/confirm")).toBe(false);
  });
});

describe("isZeroVarianceRepeatCapture", () => {
  const beaconUrl = "https://apply.acme.example/auth/responder.html?clientId=X&environment=PROD";

  it("flags a same-host, fixed-query beacon with a byte-identical body across occurrences", () => {
    const first = { method: "GET", url: beaconUrl, requestPostData: null };
    const occurrences = [first, { method: "GET", url: beaconUrl, requestPostData: null }];
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(true);
  });

  it("flags a same-host, fixed-query beacon whose body varies per call but whose response carries no business state", () => {
    const first = {
      method: "GET",
      url: beaconUrl,
      requestPostData: "fingerprint=abc123",
      responseHeaders: { "content-type": "text/html" },
      responseBody: "<html></html>",
    };
    const occurrences = [
      first,
      {
        method: "GET",
        url: beaconUrl,
        requestPostData: "fingerprint=def456",
        responseHeaders: { "content-type": "text/html" },
        responseBody: "<html></html>",
      },
    ];
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(true);
  });

  it("does not flag a legitimately-polled own endpoint whose response carries real JSON business state", () => {
    const first = {
      method: "GET",
      url: beaconUrl,
      requestPostData: "fingerprint=abc123",
      responseHeaders: { "content-type": "application/json" },
      responseBody: { enabled: true, variant: "control" },
    };
    const occurrences = [
      first,
      {
        method: "GET",
        url: beaconUrl,
        requestPostData: "fingerprint=def456",
        responseHeaders: { "content-type": "application/json" },
        responseBody: { enabled: true, variant: "control" },
      },
    ];
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(false);
  });

  it("flags a same-host, fixed-query beacon whose body varies per call and whose JSON response only echoes its own fixed query", () => {
    const first = {
      method: "GET",
      url: beaconUrl,
      requestPostData: "fingerprint=abc123",
      responseHeaders: { "content-type": "application/json" },
      responseBody: { clientId: "X", environment: "PROD" },
    };
    const occurrences = [
      first,
      {
        method: "GET",
        url: beaconUrl,
        requestPostData: "fingerprint=def456",
        responseHeaders: { "content-type": "application/json" },
        responseBody: { clientId: "X", environment: "PROD" },
      },
    ];
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(true);
  });

  it("flags a same-host, fixed-query beacon whose request body varies every call and whose business-looking JSON response also differs almost every occurrence", () => {
    const first = {
      method: "GET",
      url: beaconUrl,
      requestPostData: "fingerprint=abc123",
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000, greeting: "Welcome back, guest 0!" },
    };
    const occurrences = Array.from({ length: 6 }, (_, i) => ({
      method: "GET",
      url: beaconUrl,
      requestPostData: `fingerprint=${i}`,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000 + i, greeting: `Welcome back, guest ${i}!` },
    }));
    expect(isZeroVarianceRepeatCapture(first, [first, ...occurrences])).toBe(true);
  });

  it("flags a same-host, fixed-query beacon whose business-looking JSON response varies per call even when it only repeats 7 times (below the old absolute-count floor)", () => {
    const first = {
      method: "GET",
      url: beaconUrl,
      requestPostData: "fingerprint=abc123",
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000, greeting: "Welcome back, guest 0!" },
    };
    const occurrences = Array.from({ length: 7 }, (_, i) => ({
      method: "GET",
      url: beaconUrl,
      requestPostData: `fingerprint=${i}`,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000 + i, greeting: `Welcome back, guest ${i}!` },
    }));
    expect(isZeroVarianceRepeatCapture(first, [first, ...occurrences])).toBe(true);
  });

  it("does not flag a genuine closed-set toggle poll cycling between 2 states across only 6 occurrences", () => {
    const first = {
      method: "GET",
      url: beaconUrl,
      requestPostData: "fingerprint=0",
      responseHeaders: { "content-type": "application/json" },
      responseBody: { enabled: true },
    };
    const occurrences = Array.from({ length: 6 }, (_, i) => ({
      method: "GET",
      url: beaconUrl,
      requestPostData: `fingerprint=${i + 1}`,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { enabled: i % 2 === 0 },
    }));
    expect(isZeroVarianceRepeatCapture(first, [first, ...occurrences])).toBe(false);
  });

  it("does not flag a candidate with no fixed query string", () => {
    const first = {
      method: "GET",
      url: "https://apply.acme.example/health",
      requestPostData: null,
    };
    const occurrences = [
      first,
      { method: "GET", url: "https://apply.acme.example/health", requestPostData: null },
    ];
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(false);
  });

  it("flags a query-less candidate densely repeated with no business-relevant response state", () => {
    const first = {
      method: "GET",
      url: "https://apply.acme.example/widget/ping",
      requestPostData: null,
      responseHeaders: { "content-type": "text/plain" },
      responseBody: "ok",
    };
    const occurrences = Array.from({ length: 12 }, () => ({
      method: "GET",
      url: "https://apply.acme.example/widget/ping",
      requestPostData: null,
      responseHeaders: { "content-type": "text/plain" },
      responseBody: "ok",
    }));
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(true);
  });

  it("flags a query-less candidate densely repeated whose business-looking JSON response never once shows a second value", () => {
    const first = {
      method: "GET",
      url: "https://apply.acme.example/widget/toggles",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { enabled: true, variant: "control" },
    };
    const occurrences = Array.from({ length: 10 }, () => ({
      method: "GET",
      url: "https://apply.acme.example/widget/toggles",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { enabled: true, variant: "control" },
    }));
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(true);
  });

  it("does not flag a query-less candidate whose JSON response never shows a second value below the dense-repeat threshold — a genuinely-polled toggle that simply has not flipped yet in this archive produces the exact same shape at that scale", () => {
    const first = {
      method: "GET",
      url: "https://apply.acme.example/widget/toggles",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { enabled: true, variant: "control" },
    };
    const occurrences = Array.from({ length: 6 }, () => ({
      method: "GET",
      url: "https://apply.acme.example/widget/toggles",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { enabled: true, variant: "control" },
    }));
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(false);
  });

  it("does not flag a query-less candidate whose JSON response cycles between two states rather than never repeating", () => {
    const occurrences = Array.from({ length: 6 }, (_, i) => ({
      method: "GET",
      url: "https://apply.acme.example/widget/toggles",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { enabled: i % 2 === 0, variant: "control" },
    }));
    for (const occurrence of occurrences) {
      expect(isZeroVarianceRepeatCapture(occurrence, occurrences)).toBe(false);
    }
  });

  it("flags a query-less candidate with an identical request whose JSON response has non-URL-derivable leaves that vary per occurrence, even below the dense-repeat threshold — an identical request can't explain a varying response regardless of count", () => {
    const first = {
      method: "GET",
      url: "https://apply.acme.example/widget/loader",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000, greeting: "Welcome back, guest 0!" },
    };
    const occurrences = Array.from({ length: 7 }, (_, i) => ({
      method: "GET",
      url: "https://apply.acme.example/widget/loader",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000 + i, greeting: `Welcome back, guest ${i}!` },
    }));
    for (const occurrence of occurrences) {
      expect(isZeroVarianceRepeatCapture(occurrence, occurrences)).toBe(true);
    }
    expect(isZeroVarianceRepeatCapture(first, [first, ...occurrences])).toBe(true);
  });

  it("does not flag a query-less, densely-repeated POST with a varying body and no explicit content-type header", () => {
    const first = {
      method: "POST",
      url: "https://apply.acme.example/graphql",
      requestPostData: '{"op":"getViewer"}',
    };
    const occurrences = Array.from({ length: 12 }, (_, i) => ({
      method: "POST",
      url: "https://apply.acme.example/graphql",
      requestPostData: `{"op":"mutation${i}"}`,
    }));
    expect(isZeroVarianceRepeatCapture(first, [first, ...occurrences])).toBe(false);
  });

  it("flags a query-less, densely-repeated POST with a varying body when the candidate supplies an explicit content-type header with no business-relevant response state", () => {
    const first = {
      method: "POST",
      url: "https://apply.acme.example/widget/beacon",
      requestPostData: "fingerprint=abc123",
      responseHeaders: { "content-type": "text/plain" },
      responseBody: "ok",
    };
    const occurrences = Array.from({ length: 6 }, (_, i) => ({
      method: "POST",
      url: "https://apply.acme.example/widget/beacon",
      requestPostData: `fingerprint=${i}`,
      responseHeaders: { "content-type": "text/plain" },
      responseBody: "ok",
    }));
    expect(isZeroVarianceRepeatCapture(first, [first, ...occurrences])).toBe(true);
  });

  it("flags a query-less, densely-repeated POST whose request body varies every call and whose business-looking JSON response also differs almost every occurrence", () => {
    const first = {
      method: "POST",
      url: "https://apply.acme.example/widget/beacon",
      requestPostData: "fingerprint=abc123",
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000, greeting: "Welcome back, guest 0!" },
    };
    const occurrences = Array.from({ length: 10 }, (_, i) => ({
      method: "POST",
      url: "https://apply.acme.example/widget/beacon",
      requestPostData: `fingerprint=${i}`,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000 + i, greeting: `Welcome back, guest ${i}!` },
    }));
    expect(isZeroVarianceRepeatCapture(first, [first, ...occurrences])).toBe(true);
  });

  it("does not flag a query-less, densely-repeated POST with a varying body and varying JSON response when the candidate's operationName recurs as a strict majority across occurrences — a real re-issued operation, not a widget", () => {
    const first = {
      method: "POST",
      url: "https://apply.acme.example/widget/beacon",
      requestPostData: "fingerprint=abc123",
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000, greeting: "Welcome back, guest 0!" },
      operationName: "getViewer",
    };
    const occurrences = Array.from({ length: 10 }, (_, i) => ({
      method: "POST",
      url: "https://apply.acme.example/widget/beacon",
      requestPostData: `fingerprint=${i}`,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000 + i, greeting: `Welcome back, guest ${i}!` },
      operationName: "getViewer",
    }));
    expect(isZeroVarianceRepeatCapture(first, [first, ...occurrences])).toBe(false);
  });

  it("flags a query-less, densely-repeated POST with a varying body and varying JSON response when operationName is present but does not recur as a strict majority", () => {
    const first = {
      method: "POST",
      url: "https://apply.acme.example/widget/beacon",
      requestPostData: "fingerprint=abc123",
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000, greeting: "Welcome back, guest 0!" },
      operationName: "getViewer",
    };
    const occurrences = Array.from({ length: 10 }, (_, i) => ({
      method: "POST",
      url: "https://apply.acme.example/widget/beacon",
      requestPostData: `fingerprint=${i}`,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000 + i, greeting: `Welcome back, guest ${i}!` },
      operationName: `op${i}`,
    }));
    expect(isZeroVarianceRepeatCapture(first, [first, ...occurrences])).toBe(true);
  });

  it("does not flag a query-less, densely-repeated POST whose operationName recurs as the largest (but not majority) group among 3+ distinct operationName groups sharing the endpoint", () => {
    const buildOccurrence = (i: number, operationName: string) => ({
      method: "POST",
      url: "https://apply.acme.example/graphql",
      requestPostData: JSON.stringify({ operationName, variables: { i } }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { results: [{ id: `item-${i}` }] },
      operationName,
    });
    const first = buildOccurrence(0, "catalogSearch");
    const occurrences = [
      first,
      ...Array.from({ length: 4 }, (_, i) => buildOccurrence(i + 1, "catalogSearch")),
      ...Array.from({ length: 4 }, (_, i) => buildOccurrence(i + 5, "cartSummary")),
      ...Array.from({ length: 2 }, (_, i) => buildOccurrence(i + 9, "orderHistory")),
    ];
    expect(occurrences.length).toBe(11);
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(false);
  });

  it("does not flag a query-less, densely-repeated POST whose operationName recurs at least twice even when a DIFFERENT operation multiplexed on the same endpoint recurs MORE often — not merely 'largest but not majority', not the largest at all", () => {
    const buildOccurrence = (i: number, operationName: string) => ({
      method: "POST",
      url: "https://apply.acme.example/graphql",
      requestPostData: JSON.stringify({ operationName, variables: { i } }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { results: [{ id: `item-${i}` }] },
      operationName,
    });
    const first = buildOccurrence(0, "cruiseSearch_Cruises");
    const occurrences = [
      first,
      ...Array.from({ length: 4 }, (_, i) => buildOccurrence(i + 1, "cruiseSearch_Cruises")),
      ...Array.from({ length: 40 }, (_, i) => buildOccurrence(i + 5, "typeahead")),
    ];
    expect(occurrences.length).toBe(45);
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(false);
  });

  it("does not flag a query-less, densely-repeated POST whose operationName field is null but whose query text names the operation, recurring as a plurality among 3+ distinct query-text-named groups sharing the endpoint", () => {
    const buildOccurrence = (i: number, operationName: string) => ({
      method: "POST",
      url: "https://apply.acme.example/graphql",
      requestPostData: JSON.stringify({
        query: `query ${operationName} { widgets(i: ${i}) { id } }`,
        variables: { i },
      }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { results: [{ id: `item-${i}` }] },
      operationName: null,
      query: `query ${operationName} { widgets(i: ${i}) { id } }`,
    });
    const first = buildOccurrence(0, "SearchWidgets");
    const occurrences = [
      first,
      ...Array.from({ length: 4 }, (_, i) => buildOccurrence(i + 1, "SearchWidgets")),
      ...Array.from({ length: 4 }, (_, i) => buildOccurrence(i + 5, "CartSummary")),
      ...Array.from({ length: 2 }, (_, i) => buildOccurrence(i + 9, "OrderHistory")),
    ];
    expect(occurrences.length).toBe(11);
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(false);
  });

  it("flags a query-less candidate whose response never varies at only 7 occurrences when it is structurally isolated from every other endpoint in the capture run", () => {
    const first = {
      method: "GET",
      url: "https://apply.acme.example/pulse/api/v1/urgency",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { level: "high", campaign: "flash-sale" },
    };
    const occurrences = Array.from({ length: 7 }, () => ({ ...first }));
    const realFlow = [
      { method: "POST", url: "https://apply.acme.example/booking/create", requestPostData: "{}" },
      {
        method: "GET",
        url: "https://apply.acme.example/booking/sections/name",
        requestPostData: null,
      },
      { method: "POST", url: "https://apply.acme.example/booking/submit", requestPostData: "{}" },
    ];
    expect(isZeroVarianceRepeatCapture(first, [...occurrences, ...realFlow])).toBe(true);
  });

  it("does not flag a query-less candidate whose response never varies at 7 occurrences when a structurally related sibling endpoint corroborates it as part of the real flow", () => {
    const first = {
      method: "GET",
      url: "https://apply.acme.example/promo/listing-avail-vas/state",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { available: true, tier: "gold" },
    };
    const occurrences = Array.from({ length: 7 }, () => ({ ...first }));
    const relatedSibling = {
      method: "GET",
      url: "https://apply.acme.example/promo/item-detail-vas/state",
      requestPostData: null,
    };
    expect(isZeroVarianceRepeatCapture(first, [...occurrences, relatedSibling])).toBe(false);
  });

  it("does not flag a query-less candidate at 7 occurrences when a sibling endpoint shares an abbreviated/pluralized stem of its compound-segment token rather than an exact token", () => {
    const first = {
      method: "GET",
      url: "https://apply.acme.example/promo/product-avail/state",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { available: true },
    };
    const occurrences = Array.from({ length: 7 }, () => ({ ...first }));
    const relatedSibling = {
      method: "GET",
      url: "https://apply.acme.example/catalog/available-products/list",
      requestPostData: null,
    };
    expect(isZeroVarianceRepeatCapture(first, [...occurrences, relatedSibling])).toBe(false);
  });

  it("does not flag a query-less candidate with a compound segment at 7 occurrences when a sibling endpoint shares only a raw non-compound segment, not a token", () => {
    const first = {
      method: "GET",
      url: "https://apply.acme.example/feature-toggles/catalog",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { enabled: true },
    };
    const occurrences = Array.from({ length: 7 }, () => ({ ...first }));
    const relatedSibling = {
      method: "GET",
      url: "https://apply.acme.example/catalog/listing",
      requestPostData: null,
    };
    expect(isZeroVarianceRepeatCapture(first, [...occurrences, relatedSibling])).toBe(false);
  });

  it("does not flag a query-less candidate with only plain-word (non-compound) path segments at 7 occurrences when a sibling endpoint shares a raw path segment with it", () => {
    const first = {
      method: "GET",
      url: "https://apply.acme.example/user/profile",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { name: "static" },
    };
    const occurrences = Array.from({ length: 7 }, () => ({ ...first }));
    const relatedSibling = {
      method: "GET",
      url: "https://apply.acme.example/user/profile/edit",
      requestPostData: null,
    };
    expect(isZeroVarianceRepeatCapture(first, [...occurrences, relatedSibling])).toBe(false);
  });

  it("still flags two distinct, structurally-unrelated noise endpoints as noise when they share only a raw path segment (neither self-referential) and cannot mutually vouch for each other via that shared segment", () => {
    const banner = {
      method: "GET",
      url: "https://apply.acme.example/widget/banner",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { status: "active" },
    };
    const bannerOccurrences = Array.from({ length: 5 }, () => ({ ...banner }));
    const ticker = {
      method: "GET",
      url: "https://apply.acme.example/widget/ticker",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { status: "active" },
    };
    const tickerOccurrences = Array.from({ length: 5 }, () => ({ ...ticker }));
    const all = [...bannerOccurrences, ...tickerOccurrences];
    expect(isZeroVarianceRepeatCapture(banner, all)).toBe(true);
    expect(isZeroVarianceRepeatCapture(ticker, all)).toBe(true);
  });

  it("flags a query-less POST whose request body and response both vary every call at only 7 occurrences when structurally isolated from every other endpoint in the run", () => {
    const first = {
      method: "POST",
      url: "https://apply.acme.example/pulse/api/v1/urgency",
      requestPostData: "seed=0",
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000, greeting: "Welcome back, guest 0!" },
    };
    const occurrences = Array.from({ length: 7 }, (_, i) => ({
      method: "POST",
      url: "https://apply.acme.example/pulse/api/v1/urgency",
      requestPostData: `seed=${i}`,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000 + i, greeting: `Welcome back, guest ${i}!` },
    }));
    const realFlow = [
      { method: "POST", url: "https://apply.acme.example/booking/create", requestPostData: "{}" },
      {
        method: "GET",
        url: "https://apply.acme.example/booking/sections/name",
        requestPostData: null,
      },
    ];
    expect(isZeroVarianceRepeatCapture(first, [first, ...occurrences, ...realFlow])).toBe(true);
  });

  it.each([7, 12])(
    "flags a query-less, explicit-json-content-type POST whose response leaves are not derivable from the request URL or body at %i occurrences, structurally isolated from every other endpoint in the run — noise regardless of the old absolute-count floor",
    (occurrenceCount) => {
      const first = {
        method: "POST",
        url: "https://apply.acme.example/pulse/api/v1/urgency",
        requestPostData: "seed=0",
        responseHeaders: { "content-type": "application/json" },
        responseBody: { viewCount: 4000, greeting: "Welcome back, guest 0!" },
      };
      const occurrences = Array.from({ length: occurrenceCount }, (_, i) => ({
        method: "POST",
        url: "https://apply.acme.example/pulse/api/v1/urgency",
        requestPostData: `seed=${i}`,
        responseHeaders: { "content-type": "application/json" },
        responseBody: { viewCount: 4000 + i, greeting: `Welcome back, guest ${i}!` },
      }));
      const realFlow = [
        { method: "POST", url: "https://apply.acme.example/booking/create", requestPostData: "{}" },
        {
          method: "GET",
          url: "https://apply.acme.example/booking/sections/name",
          requestPostData: null,
        },
      ];
      expect(isZeroVarianceRepeatCapture(first, [first, ...occurrences, ...realFlow])).toBe(true);
    }
  );

  it("does not flag a query-less POST whose request body and response both vary every call at 7 occurrences when a structurally related sibling endpoint corroborates it as part of the real flow", () => {
    const first = {
      method: "POST",
      url: "https://apply.acme.example/promo/listing-avail-vas/state",
      requestPostData: "seed=0",
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000, greeting: "Welcome back, guest 0!" },
    };
    const occurrences = Array.from({ length: 7 }, (_, i) => ({
      method: "POST",
      url: "https://apply.acme.example/promo/listing-avail-vas/state",
      requestPostData: `seed=${i}`,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000 + i, greeting: `Welcome back, guest ${i}!` },
    }));
    const relatedSibling = {
      method: "GET",
      url: "https://apply.acme.example/promo/item-detail-vas/state",
      requestPostData: null,
    };
    expect(isZeroVarianceRepeatCapture(first, [first, ...occurrences, relatedSibling])).toBe(false);
  });

  it("flags a query-less POST whose request body ALSO varies every call below the dense-repeat threshold, when its response leaves are not derivable from the request and it is structurally isolated from every other endpoint in the run", () => {
    const first = {
      method: "POST",
      url: "https://apply.acme.example/widget/beacon",
      requestPostData: "fingerprint=abc123",
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000, greeting: "Welcome back, guest 0!" },
    };
    const occurrences = Array.from({ length: 7 }, (_, i) => ({
      method: "POST",
      url: "https://apply.acme.example/widget/beacon",
      requestPostData: `fingerprint=${i}`,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000 + i, greeting: `Welcome back, guest ${i}!` },
    }));
    const realFlow = [
      { method: "POST", url: "https://apply.acme.example/booking/create", requestPostData: "{}" },
      {
        method: "GET",
        url: "https://apply.acme.example/booking/sections/name",
        requestPostData: null,
      },
    ];
    expect(isZeroVarianceRepeatCapture(first, [first, ...occurrences, ...realFlow])).toBe(true);
  });

  it("does not flag a query-less, structurally-isolated POST drill whose per-call response leaves are entirely derivable from that same call's own request body, at a low occurrence count below the old dense-repeat floor", () => {
    const first = {
      method: "POST",
      url: "https://apply.acme.example/catalog/item/lookup",
      requestPostData: '{"itemId":"1000"}',
      responseHeaders: { "content-type": "application/json" },
      responseBody: { itemId: "1000" },
    };
    const occurrences = Array.from({ length: 5 }, (_, i) => ({
      method: "POST",
      url: "https://apply.acme.example/catalog/item/lookup",
      requestPostData: `{"itemId":"${1001 + i}"}`,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { itemId: `${1001 + i}` },
    }));
    const unrelatedFlow = [
      { method: "GET", url: "https://apply.acme.example/auth/session", requestPostData: null },
    ];
    expect(isZeroVarianceRepeatCapture(first, [first, ...occurrences, ...unrelatedFlow])).toBe(
      false
    );
  });

  it("flags a query-less, structurally-isolated widget at 7 occurrences and never flags any real endpoint in a realistically diverse pool of endpoint families", () => {
    const first = {
      method: "GET",
      url: "https://apply.acme.example/pulse/api/v1/urgency",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { level: "high", campaign: "flash-sale" },
    };
    const occurrences = Array.from({ length: 7 }, () => ({ ...first }));
    const diversePool = [
      { method: "GET", url: "https://apply.acme.example/booking/search", requestPostData: null },
      {
        method: "GET",
        url: "https://apply.acme.example/booking/sections/name",
        requestPostData: null,
      },
      { method: "POST", url: "https://apply.acme.example/booking/create", requestPostData: "{}" },
      { method: "POST", url: "https://apply.acme.example/booking/submit", requestPostData: "{}" },
      {
        method: "GET",
        url: "https://apply.acme.example/catalog/item-detail-vas",
        requestPostData: null,
      },
      {
        method: "GET",
        url: "https://apply.acme.example/promo/listing-avail-vas/state",
        requestPostData: null,
      },
      {
        method: "GET",
        url: "https://apply.acme.example/promo/item-detail-vas/state",
        requestPostData: null,
      },
      {
        method: "GET",
        url: "https://apply.acme.example/promo/product-avail/state",
        requestPostData: null,
      },
      {
        method: "GET",
        url: "https://apply.acme.example/catalog/available-products/list",
        requestPostData: null,
      },
      {
        method: "GET",
        url: "https://apply.acme.example/feature-toggles/catalog",
        requestPostData: null,
      },
      { method: "GET", url: "https://apply.acme.example/catalog/listing", requestPostData: null },
      { method: "GET", url: "https://apply.acme.example/user/profile", requestPostData: null },
      {
        method: "GET",
        url: "https://apply.acme.example/user/profile/edit",
        requestPostData: null,
      },
      {
        method: "POST",
        url: "https://apply.acme.example/catalog/item/lookup",
        requestPostData: '{"itemId":"1000"}',
      },
      { method: "GET", url: "https://apply.acme.example/auth/session", requestPostData: null },
      { method: "GET", url: "https://apply.acme.example/widget/ping", requestPostData: null },
      {
        method: "POST",
        url: "https://apply.acme.example/widget/beacon",
        requestPostData: "fingerprint=abc123",
      },
      {
        method: "GET",
        url: "https://apply.acme.example/account/settings/notifications",
        requestPostData: null,
      },
      {
        method: "GET",
        url: "https://apply.acme.example/checkout/payment-methods",
        requestPostData: null,
      },
      {
        method: "POST",
        url: "https://apply.acme.example/checkout/apply-discount",
        requestPostData: "{}",
      },
      {
        method: "GET",
        url: "https://apply.acme.example/shipping/address-book",
        requestPostData: null,
      },
      {
        method: "GET",
        url: "https://apply.acme.example/inventory/warehouse-status",
        requestPostData: null,
      },
      {
        method: "GET",
        url: "https://apply.acme.example/reviews/product-summary",
        requestPostData: null,
      },
      {
        method: "GET",
        url: "https://apply.acme.example/support/ticket-history",
        requestPostData: null,
      },
      {
        method: "GET",
        url: "https://apply.acme.example/loyalty/rewards-balance",
        requestPostData: null,
      },
      {
        method: "POST",
        url: "https://apply.acme.example/newsletter/subscribe-preferences",
        requestPostData: "{}",
      },
    ];
    const allCaptures = [...occurrences, ...diversePool];
    expect(isZeroVarianceRepeatCapture(first, allCaptures)).toBe(true);
    for (const realEndpoint of diversePool) {
      expect(isZeroVarianceRepeatCapture(realEndpoint, allCaptures)).toBe(false);
    }
  });

  it("does not flag a query-less candidate below the dense-repeat threshold", () => {
    const first = {
      method: "GET",
      url: "https://apply.acme.example/widget/ping",
      requestPostData: null,
      responseHeaders: { "content-type": "text/plain" },
      responseBody: "ok",
    };
    const occurrences = [
      first,
      {
        method: "GET",
        url: "https://apply.acme.example/widget/ping",
        requestPostData: null,
        responseHeaders: { "content-type": "text/plain" },
        responseBody: "ok",
      },
    ];
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(false);
  });

  it("does not flag a fixed-query capture that never recurs", () => {
    const first = { method: "GET", url: beaconUrl, requestPostData: null };
    expect(isZeroVarianceRepeatCapture(first, [first])).toBe(false);
  });

  it("flags a same-host beacon whose fixed clientId/environment recur alongside one incidental varying query key", () => {
    const first = {
      method: "GET",
      url: `${beaconUrl}&nonce=aaa111`,
      requestPostData: null,
    };
    const occurrences = [
      first,
      {
        method: "GET",
        url: `${beaconUrl}&nonce=bbb222`,
        requestPostData: null,
      },
    ];
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(true);
  });

  it("flags a fixed-query beacon fired 14 times against 38 total captures, even though one earlier same-endpoint occurrence carries a different value for every key", () => {
    const candidate = {
      method: "GET",
      url: beaconUrl,
      requestPostData: null,
    };
    const genuineOccurrences = Array.from({ length: 13 }, () => ({
      method: "GET",
      url: beaconUrl,
      requestPostData: null,
    }));
    const preFlowOutlier = {
      method: "GET",
      url: "https://apply.acme.example/auth/responder.html?clientId=Y&environment=DEV",
      requestPostData: null,
    };
    const unrelatedFlowCaptures = Array.from({ length: 23 }, (_, i) => ({
      method: "POST",
      url: `https://apply.acme.example/api/step-${i}`,
      requestPostData: `{"step":${i}}`,
    }));
    const allCaptures = [
      candidate,
      ...genuineOccurrences,
      preFlowOutlier,
      ...unrelatedFlowCaptures,
    ];
    expect(allCaptures.length).toBe(38);
    expect(isZeroVarianceRepeatCapture(candidate, allCaptures)).toBe(true);
  });

  it("does not flag a query key matching in exactly half of same-endpoint occurrences (a true 50/50 tie)", () => {
    const candidate = {
      method: "GET",
      url: "https://apply.acme.example/auth/responder.html?clientId=X&environment=PROD",
      requestPostData: null,
    };
    const occurrences = [
      candidate,
      {
        method: "GET",
        url: "https://apply.acme.example/auth/responder.html?clientId=X&environment=DEV",
        requestPostData: null,
      },
      {
        method: "GET",
        url: "https://apply.acme.example/auth/responder.html?clientId=Y&environment=STAGE",
        requestPostData: null,
      },
      {
        method: "GET",
        url: "https://apply.acme.example/auth/responder.html?clientId=Z&environment=TEST",
        requestPostData: null,
      },
    ];
    expect(isZeroVarianceRepeatCapture(candidate, occurrences)).toBe(false);
  });

  it("flags a query key matching in a bare majority (one more than a 50/50 tie) of same-endpoint occurrences", () => {
    const candidate = {
      method: "GET",
      url: "https://apply.acme.example/auth/responder.html?clientId=X&environment=PROD",
      requestPostData: null,
    };
    const occurrences = [
      candidate,
      {
        method: "GET",
        url: "https://apply.acme.example/auth/responder.html?clientId=X&environment=DEV",
        requestPostData: null,
      },
      {
        method: "GET",
        url: "https://apply.acme.example/auth/responder.html?clientId=X&environment=STAGE",
        requestPostData: null,
      },
      {
        method: "GET",
        url: "https://apply.acme.example/auth/responder.html?clientId=Y&environment=TEST",
        requestPostData: null,
      },
    ];
    expect(isZeroVarianceRepeatCapture(candidate, occurrences)).toBe(true);
  });

  it("admits a dense archive of mixed noise (fixed-query third-party beacon, queryless bot-sensor pixel, repeated own-domain widget with per-load-varying values) while refusing the real search+drill pair", () => {
    const searchCapture = {
      method: "POST",
      url: "https://apply.acme.example/api/search",
      requestPostData: '{"destination":"Bahamas","month":"2026-10"}',
      responseHeaders: { "content-type": "application/json" },
      responseBody: { results: [{ id: "cruise-1" }, { id: "cruise-2" }] },
    };
    const drillCapture = {
      method: "GET",
      url: "https://apply.acme.example/api/search/details?id=cruise-1",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { id: "cruise-1", price: 899 },
    };
    const thirdPartyBeacon = Array.from({ length: 20 }, (_, i) => ({
      method: "GET",
      url: `https://pixel.adnoise.example/beacon?clientId=X&environment=PROD&nonce=${i}`,
      requestPostData: null,
    }));
    const botSensorPixel = Array.from({ length: 14 }, () => ({
      method: "GET",
      url: "https://apply.acme.example/sensor.gif",
      requestPostData: null,
    }));
    const widgetOccurrences = Array.from({ length: 12 }, (_, i) => ({
      method: "GET",
      url: "https://apply.acme.example/widget/loader",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000 + i, greeting: `Welcome back, guest ${i}!` },
    }));
    const allCaptures = [
      searchCapture,
      drillCapture,
      ...thirdPartyBeacon,
      ...botSensorPixel,
      ...widgetOccurrences,
    ];
    expect(allCaptures.length).toBe(48);
    for (const beacon of thirdPartyBeacon) {
      expect(isZeroVarianceRepeatCapture(beacon, allCaptures)).toBe(true);
    }
    for (const pixel of botSensorPixel) {
      expect(isZeroVarianceRepeatCapture(pixel, allCaptures)).toBe(true);
    }
    for (const widgetCall of widgetOccurrences) {
      expect(isZeroVarianceRepeatCapture(widgetCall, allCaptures)).toBe(true);
    }
    expect(isZeroVarianceRepeatCapture(searchCapture, allCaptures)).toBe(false);
    expect(isZeroVarianceRepeatCapture(drillCapture, allCaptures)).toBe(false);
  });

  it("admits a combined archive of all four previously-excluded noise shapes while retaining a densely-repeated real search+drill pair", () => {
    const searchOccurrences = Array.from({ length: 18 }, (_, i) => ({
      method: "POST",
      url: "https://apply.acme.example/graphql",
      requestPostData: JSON.stringify({
        operationName: "catalogSearch",
        variables: { destination: `region-${i}`, month: `2026-${(i % 12) + 1}` },
      }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { results: [{ id: `item-${i}`, price: 100 + i }] },
      operationName: "catalogSearch",
    }));
    const drillCapture = {
      method: "GET",
      url: "https://apply.acme.example/catalog/item/details?id=item-0",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { id: "item-0", price: 100 },
    };
    const fixedQueryBeacon = Array.from({ length: 15 }, (_, i) => ({
      method: "GET",
      url: `${beaconUrl}&nonce=${i}`,
      requestPostData: null,
    }));
    const querylessBotPixel = Array.from({ length: 14 }, () => ({
      method: "GET",
      url: "https://apply.acme.example/sensor.gif",
      requestPostData: null,
    }));
    const freelyVaryingWidget = Array.from({ length: 12 }, (_, i) => ({
      method: "GET",
      url: "https://apply.acme.example/widget/loader",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000 + i, greeting: `Welcome back, guest ${i}!` },
    }));
    const allCaptures = [
      ...searchOccurrences,
      drillCapture,
      ...fixedQueryBeacon,
      ...querylessBotPixel,
      ...freelyVaryingWidget,
    ];
    for (const beacon of fixedQueryBeacon) {
      expect(isZeroVarianceRepeatCapture(beacon, allCaptures)).toBe(true);
    }
    for (const pixel of querylessBotPixel) {
      expect(isZeroVarianceRepeatCapture(pixel, allCaptures)).toBe(true);
    }
    for (const widgetCall of freelyVaryingWidget) {
      expect(isZeroVarianceRepeatCapture(widgetCall, allCaptures)).toBe(true);
    }
    for (const searchCall of searchOccurrences) {
      expect(isZeroVarianceRepeatCapture(searchCall, allCaptures)).toBe(false);
    }
    expect(isZeroVarianceRepeatCapture(drillCapture, allCaptures)).toBe(false);
  });

  it("admits a combined archive of all four previously-excluded noise shapes plus a query-text-only GraphQL primary while retaining both real search+drill pairs", () => {
    const searchOccurrences = Array.from({ length: 18 }, (_, i) => ({
      method: "POST",
      url: "https://apply.acme.example/graphql",
      requestPostData: JSON.stringify({
        operationName: "catalogSearch",
        variables: { destination: `region-${i}`, month: `2026-${(i % 12) + 1}` },
      }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { results: [{ id: `item-${i}`, price: 100 + i }] },
      operationName: "catalogSearch",
    }));
    const drillCapture = {
      method: "GET",
      url: "https://apply.acme.example/catalog/item/details?id=item-0",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { id: "item-0", price: 100 },
    };
    const fixedQueryBeacon = Array.from({ length: 15 }, (_, i) => ({
      method: "GET",
      url: `${beaconUrl}&nonce=${i}`,
      requestPostData: null,
    }));
    const querylessBotPixel = Array.from({ length: 14 }, () => ({
      method: "GET",
      url: "https://apply.acme.example/sensor.gif",
      requestPostData: null,
    }));
    const freelyVaryingWidget = Array.from({ length: 12 }, (_, i) => ({
      method: "GET",
      url: "https://apply.acme.example/widget/loader",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000 + i, greeting: `Welcome back, guest ${i}!` },
    }));
    const queryTextSearchOccurrences = Array.from({ length: 19 }, (_, i) => {
      const query = `query catalogSearch($destination: String!, $month: String!) { search(destination: $destination, month: $month) { id price } }`;
      return {
        method: "POST",
        url: "https://apply.acme.example/graphql",
        requestPostData: JSON.stringify({
          query,
          operationName: null,
          variables: { destination: `region-${i}`, month: `2026-${(i % 12) + 1}` },
        }),
        responseHeaders: { "content-type": "application/json" },
        responseBody: { results: [{ id: `item-${i}`, price: 100 + i }] },
        operationName: null,
        query,
      };
    });
    const queryTextDrillCapture = {
      method: "GET",
      url: "https://apply.acme.example/catalog/item/details?id=item-1",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { id: "item-1", price: 100 },
    };
    const allCaptures = [
      ...searchOccurrences,
      drillCapture,
      ...fixedQueryBeacon,
      ...querylessBotPixel,
      ...freelyVaryingWidget,
      ...queryTextSearchOccurrences,
      queryTextDrillCapture,
    ];
    for (const beacon of fixedQueryBeacon) {
      expect(isZeroVarianceRepeatCapture(beacon, allCaptures)).toBe(true);
    }
    for (const pixel of querylessBotPixel) {
      expect(isZeroVarianceRepeatCapture(pixel, allCaptures)).toBe(true);
    }
    for (const widgetCall of freelyVaryingWidget) {
      expect(isZeroVarianceRepeatCapture(widgetCall, allCaptures)).toBe(true);
    }
    for (const searchCall of searchOccurrences) {
      expect(isZeroVarianceRepeatCapture(searchCall, allCaptures)).toBe(false);
    }
    expect(isZeroVarianceRepeatCapture(drillCapture, allCaptures)).toBe(false);
    for (const occurrence of queryTextSearchOccurrences) {
      expect(isZeroVarianceRepeatCapture(occurrence, allCaptures)).toBe(false);
    }
    expect(isZeroVarianceRepeatCapture(queryTextDrillCapture, allCaptures)).toBe(false);
  });

  it("admits a combined archive of all four previously-excluded noise shapes plus a query-text-only GraphQL primary while retaining a densely re-issued named search primary with a later Automatic-Persisted-Query re-issue and its drill", () => {
    const searchOccurrences = Array.from({ length: 18 }, (_, i) => ({
      method: "POST",
      url: "https://apply.acme.example/graphql",
      requestPostData: JSON.stringify({
        operationName: "catalogSearch",
        variables: { destination: `region-${i}`, month: `2026-${(i % 12) + 1}` },
      }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { results: [{ id: `item-${i}`, price: 100 + i }] },
      operationName: "catalogSearch",
    }));
    const drillCapture = {
      method: "GET",
      url: "https://apply.acme.example/catalog/item/details?id=item-0",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { id: "item-0", price: 100 },
    };
    const fixedQueryBeacon = Array.from({ length: 15 }, (_, i) => ({
      method: "GET",
      url: `${beaconUrl}&nonce=${i}`,
      requestPostData: null,
    }));
    const querylessBotPixel = Array.from({ length: 14 }, () => ({
      method: "GET",
      url: "https://apply.acme.example/sensor.gif",
      requestPostData: null,
    }));
    const freelyVaryingWidget = Array.from({ length: 12 }, (_, i) => ({
      method: "GET",
      url: "https://apply.acme.example/widget/loader",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000 + i, greeting: `Welcome back, guest ${i}!` },
    }));
    const queryTextSearchOccurrences = Array.from({ length: 19 }, (_, i) => {
      const query = `query catalogSearch($destination: String!, $month: String!) { search(destination: $destination, month: $month) { id price } }`;
      return {
        method: "POST",
        url: "https://apply.acme.example/graphql",
        requestPostData: JSON.stringify({
          query,
          operationName: null,
          variables: { destination: `region-${i}`, month: `2026-${(i % 12) + 1}` },
        }),
        responseHeaders: { "content-type": "application/json" },
        responseBody: { results: [{ id: `item-${i}`, price: 100 + i }] },
        operationName: null,
        query,
      };
    });
    const queryTextDrillCapture = {
      method: "GET",
      url: "https://apply.acme.example/catalog/item/details?id=item-1",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { id: "item-1", price: 100 },
    };
    const apqReissueIndex = 15;
    const apqSearchOccurrences = Array.from({ length: 19 }, (_, i) => {
      const isApqReissue = i === apqReissueIndex;
      return {
        method: "POST",
        url: "https://apply.acme.example/graphql2",
        requestPostData: JSON.stringify({
          operationName: isApqReissue ? null : "catalogSearch",
          query: isApqReissue ? "" : undefined,
          variables: { destination: `region-${i}`, month: `2026-${(i % 12) + 1}` },
        }),
        responseHeaders: { "content-type": "application/json" },
        responseBody: { results: [{ id: `item-${i}`, price: 100 + i }] },
        operationName: isApqReissue ? null : "catalogSearch",
        query: isApqReissue ? "" : undefined,
      };
    });
    const apqDrillCapture = {
      method: "GET",
      url: "https://apply.acme.example/catalog/item/details?id=item-2",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { id: "item-2", price: 100 },
    };
    const allCaptures = [
      ...searchOccurrences,
      drillCapture,
      ...fixedQueryBeacon,
      ...querylessBotPixel,
      ...freelyVaryingWidget,
      ...queryTextSearchOccurrences,
      queryTextDrillCapture,
      ...apqSearchOccurrences,
      apqDrillCapture,
    ];
    for (const beacon of fixedQueryBeacon) {
      expect(isZeroVarianceRepeatCapture(beacon, allCaptures)).toBe(true);
    }
    for (const pixel of querylessBotPixel) {
      expect(isZeroVarianceRepeatCapture(pixel, allCaptures)).toBe(true);
    }
    for (const widgetCall of freelyVaryingWidget) {
      expect(isZeroVarianceRepeatCapture(widgetCall, allCaptures)).toBe(true);
    }
    for (const searchCall of searchOccurrences) {
      expect(isZeroVarianceRepeatCapture(searchCall, allCaptures)).toBe(false);
    }
    expect(isZeroVarianceRepeatCapture(drillCapture, allCaptures)).toBe(false);
    for (const occurrence of queryTextSearchOccurrences) {
      expect(isZeroVarianceRepeatCapture(occurrence, allCaptures)).toBe(false);
    }
    expect(isZeroVarianceRepeatCapture(queryTextDrillCapture, allCaptures)).toBe(false);
    for (const occurrence of apqSearchOccurrences) {
      expect(isZeroVarianceRepeatCapture(occurrence, allCaptures)).toBe(false);
    }
    expect(isZeroVarianceRepeatCapture(apqDrillCapture, allCaptures)).toBe(false);
  });

  it("admits a combined archive of all four previously-excluded noise shapes plus a query-text-only GraphQL primary and an APQ-reissued primary while retaining a production-scale multi-operation real primary sharing its endpoint with hundreds of one-off operations, including one that outfires it", () => {
    const searchOccurrences = Array.from({ length: 18 }, (_, i) => ({
      method: "POST",
      url: "https://apply.acme.example/graphql",
      requestPostData: JSON.stringify({
        operationName: "catalogSearch",
        variables: { destination: `region-${i}`, month: `2026-${(i % 12) + 1}` },
      }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { results: [{ id: `item-${i}`, price: 100 + i }] },
      operationName: "catalogSearch",
    }));
    const drillCapture = {
      method: "GET",
      url: "https://apply.acme.example/catalog/item/details?id=item-0",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { id: "item-0", price: 100 },
    };
    const fixedQueryBeacon = Array.from({ length: 15 }, (_, i) => ({
      method: "GET",
      url: `${beaconUrl}&nonce=${i}`,
      requestPostData: null,
    }));
    const querylessBotPixel = Array.from({ length: 14 }, () => ({
      method: "GET",
      url: "https://apply.acme.example/sensor.gif",
      requestPostData: null,
    }));
    const freelyVaryingWidget = Array.from({ length: 12 }, (_, i) => ({
      method: "GET",
      url: "https://apply.acme.example/widget/loader",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { viewCount: 4000 + i, greeting: `Welcome back, guest ${i}!` },
    }));
    const queryTextSearchOccurrences = Array.from({ length: 19 }, (_, i) => {
      const query = `query catalogSearch($destination: String!, $month: String!) { search(destination: $destination, month: $month) { id price } }`;
      return {
        method: "POST",
        url: "https://apply.acme.example/graphql",
        requestPostData: JSON.stringify({
          query,
          operationName: null,
          variables: { destination: `region-${i}`, month: `2026-${(i % 12) + 1}` },
        }),
        responseHeaders: { "content-type": "application/json" },
        responseBody: { results: [{ id: `item-${i}`, price: 100 + i }] },
        operationName: null,
        query,
      };
    });
    const queryTextDrillCapture = {
      method: "GET",
      url: "https://apply.acme.example/catalog/item/details?id=item-1",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { id: "item-1", price: 100 },
    };
    const apqReissueIndex = 15;
    const apqSearchOccurrences = Array.from({ length: 19 }, (_, i) => {
      const isApqReissue = i === apqReissueIndex;
      return {
        method: "POST",
        url: "https://apply.acme.example/graphql2",
        requestPostData: JSON.stringify({
          operationName: isApqReissue ? null : "catalogSearch",
          query: isApqReissue ? "" : undefined,
          variables: { destination: `region-${i}`, month: `2026-${(i % 12) + 1}` },
        }),
        responseHeaders: { "content-type": "application/json" },
        responseBody: { results: [{ id: `item-${i}`, price: 100 + i }] },
        operationName: isApqReissue ? null : "catalogSearch",
        query: isApqReissue ? "" : undefined,
      };
    });
    const apqDrillCapture = {
      method: "GET",
      url: "https://apply.acme.example/catalog/item/details?id=item-2",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { id: "item-2", price: 100 },
    };
    // Production-scale shape: a genuinely repeated search primary shares its
    // own endpoint with 240 distinct one-off operations (1-12 occurrences
    // each) plus a single sibling that outfires the primary itself
    // (25 > 19) — the exact volume of concurrently-multiplexed same-endpoint
    // traffic that used to sink hasStableOperationIdentity's cross-operation
    // plurality gate and drop the primary from the fold candidate pool.
    const multiOpEndpoint = "https://apply.acme.example/graphql3";
    const multiOpSearchOccurrences = Array.from({ length: 19 }, (_, i) => ({
      method: "POST",
      url: multiOpEndpoint,
      requestPostData: JSON.stringify({
        operationName: "catalogSearch",
        variables: { page: i + 1 },
      }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { results: [{ id: `sku-${i}`, price: 100 + i }] },
      operationName: "catalogSearch",
    }));
    const multiOpDrillCapture = {
      method: "GET",
      url: "https://apply.acme.example/catalog/item/details?id=sku-0",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { id: "sku-0", price: 100 },
    };
    const buildOneOffOperationOccurrences = (operationName: string, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        method: "POST",
        url: multiOpEndpoint,
        requestPostData: JSON.stringify({ operationName, variables: { occurrence: i } }),
        responseHeaders: { "content-type": "application/json" },
        responseBody: { [operationName]: { id: `${operationName}-${i}` } },
        operationName,
      }));
    const oneOffOperations = Array.from({ length: 240 }, (_, opIndex) =>
      buildOneOffOperationOccurrences(`getWidgetData${opIndex}`, (opIndex % 12) + 1)
    ).flat();
    const outMultiplyingOperation = buildOneOffOperationOccurrences("getFeatureFlagsRefresh", 25);
    const allCaptures = [
      ...searchOccurrences,
      drillCapture,
      ...fixedQueryBeacon,
      ...querylessBotPixel,
      ...freelyVaryingWidget,
      ...queryTextSearchOccurrences,
      queryTextDrillCapture,
      ...apqSearchOccurrences,
      apqDrillCapture,
      ...multiOpSearchOccurrences,
      multiOpDrillCapture,
      ...oneOffOperations,
      ...outMultiplyingOperation,
    ];
    for (const beacon of fixedQueryBeacon) {
      expect(isZeroVarianceRepeatCapture(beacon, allCaptures)).toBe(true);
    }
    for (const pixel of querylessBotPixel) {
      expect(isZeroVarianceRepeatCapture(pixel, allCaptures)).toBe(true);
    }
    for (const widgetCall of freelyVaryingWidget) {
      expect(isZeroVarianceRepeatCapture(widgetCall, allCaptures)).toBe(true);
    }
    for (const searchCall of searchOccurrences) {
      expect(isZeroVarianceRepeatCapture(searchCall, allCaptures)).toBe(false);
    }
    expect(isZeroVarianceRepeatCapture(drillCapture, allCaptures)).toBe(false);
    for (const occurrence of queryTextSearchOccurrences) {
      expect(isZeroVarianceRepeatCapture(occurrence, allCaptures)).toBe(false);
    }
    expect(isZeroVarianceRepeatCapture(queryTextDrillCapture, allCaptures)).toBe(false);
    for (const occurrence of apqSearchOccurrences) {
      expect(isZeroVarianceRepeatCapture(occurrence, allCaptures)).toBe(false);
    }
    expect(isZeroVarianceRepeatCapture(apqDrillCapture, allCaptures)).toBe(false);
    for (const occurrence of multiOpSearchOccurrences) {
      expect(isZeroVarianceRepeatCapture(occurrence, allCaptures)).toBe(false);
    }
    expect(isZeroVarianceRepeatCapture(multiOpDrillCapture, allCaptures)).toBe(false);
  });

  it("does not flag a query-less, explicit-json POST search primary re-issued 19 times with a stable operationName, varying variables, and a genuinely varying business response, nor its drill", () => {
    const searchOccurrences = Array.from({ length: 19 }, (_, i) => ({
      method: "POST",
      url: "https://apply.acme.example/graphql",
      requestPostData: JSON.stringify({
        operationName: "catalogSearch",
        variables: { destination: `region-${i}`, month: `2026-${(i % 12) + 1}` },
      }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { results: [{ id: `item-${i}`, price: 100 + i }] },
      operationName: "catalogSearch",
    }));
    const drillCapture = {
      method: "GET",
      url: "https://apply.acme.example/catalog/item/details?id=item-0",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { id: "item-0", price: 100 },
    };
    const allCaptures = [...searchOccurrences, drillCapture];
    for (const occurrence of searchOccurrences) {
      expect(isZeroVarianceRepeatCapture(occurrence, allCaptures)).toBe(false);
    }
    expect(isZeroVarianceRepeatCapture(drillCapture, allCaptures)).toBe(false);
  });

  it("does not flag a query-less, explicit-json POST search primary re-issued 19 times whose operationName field is null but whose query text names the operation as a strict majority, with varying variables and a genuinely varying business response, nor its drill", () => {
    const searchOccurrences = Array.from({ length: 19 }, (_, i) => {
      const query = `query catalogSearch($destination: String!, $month: String!) { search(destination: $destination, month: $month) { id price } }`;
      return {
        method: "POST",
        url: "https://apply.acme.example/graphql",
        requestPostData: JSON.stringify({
          query,
          operationName: null,
          variables: { destination: `region-${i}`, month: `2026-${(i % 12) + 1}` },
        }),
        responseHeaders: { "content-type": "application/json" },
        responseBody: { results: [{ id: `item-${i}`, price: 100 + i }] },
        operationName: null,
        query,
      };
    });
    const drillCapture = {
      method: "GET",
      url: "https://apply.acme.example/catalog/item/details?id=item-0",
      requestPostData: null,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { id: "item-0", price: 100 },
    };
    const allCaptures = [...searchOccurrences, drillCapture];
    for (const occurrence of searchOccurrences) {
      expect(isZeroVarianceRepeatCapture(occurrence, allCaptures)).toBe(false);
    }
    expect(isZeroVarianceRepeatCapture(drillCapture, allCaptures)).toBe(false);
  });

  it("does not flag a query-less, densely re-issued named GraphQL search operation, including a later Automatic-Persisted-Query re-issue with null operationName and no query text corroborated only by shared endpoint and response shape, interleaved with many distinct one-off operations at the same endpoint", () => {
    const apqReissueIndex = 15;
    const searchOccurrences = Array.from({ length: 19 }, (_, i) => {
      const isApqReissue = i === apqReissueIndex;
      return {
        method: "POST",
        url: "https://apply.acme.example/graphql",
        requestPostData: JSON.stringify({
          operationName: isApqReissue ? null : "catalogSearch",
          query: isApqReissue ? "" : undefined,
          variables: { destination: `region-${i}`, month: `2026-${(i % 12) + 1}` },
        }),
        responseHeaders: { "content-type": "application/json" },
        responseBody: { results: [{ id: `item-${i}`, price: 100 + i }] },
        operationName: isApqReissue ? null : "catalogSearch",
        query: isApqReissue ? "" : undefined,
      };
    });
    const oneOffOperations = Array.from({ length: 8 }, (_, i) => ({
      method: "POST",
      url: "https://apply.acme.example/graphql",
      requestPostData: JSON.stringify({ operationName: `oneOff${i}`, variables: { i } }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { widget: { id: i } },
      operationName: `oneOff${i}`,
    }));
    const allCaptures = [...searchOccurrences, ...oneOffOperations];
    for (const occurrence of searchOccurrences) {
      expect(isZeroVarianceRepeatCapture(occurrence, allCaptures)).toBe(false);
    }
  });

  it("does not flag a fixed-query-string GraphQL candidate whose operationName recurs as the largest (but not majority) group among 3+ distinct operationName groups sharing the endpoint", () => {
    const buildOccurrence = (i: number, operationName: string) => ({
      method: "POST",
      url: "https://apply.acme.example/graphql?v=1",
      requestPostData: JSON.stringify({ operationName, variables: { i } }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { results: [{ id: `item-${i}` }] },
      operationName,
    });
    const first = buildOccurrence(0, "catalogSearch");
    const occurrences = [
      first,
      ...Array.from({ length: 4 }, (_, i) => buildOccurrence(i + 1, "catalogSearch")),
      ...Array.from({ length: 4 }, (_, i) => buildOccurrence(i + 5, "cartSummary")),
      ...Array.from({ length: 2 }, (_, i) => buildOccurrence(i + 9, "orderHistory")),
    ];
    expect(occurrences.length).toBe(11);
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(false);
  });

  it("does not flag a fixed-query-string GraphQL candidate whose operationName recurs at least twice even when a DIFFERENT operation multiplexed on the same endpoint recurs MORE often — not merely 'largest but not majority', not the largest at all", () => {
    const buildOccurrence = (i: number, operationName: string) => ({
      method: "POST",
      url: "https://apply.acme.example/graphql?v=1",
      requestPostData: JSON.stringify({ operationName, variables: { i } }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { results: [{ id: `item-${i}` }] },
      operationName,
    });
    const first = buildOccurrence(0, "cruiseSearch_Cruises");
    const occurrences = [
      first,
      ...Array.from({ length: 4 }, (_, i) => buildOccurrence(i + 1, "cruiseSearch_Cruises")),
      ...Array.from({ length: 40 }, (_, i) => buildOccurrence(i + 5, "typeahead")),
    ];
    expect(occurrences.length).toBe(45);
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(false);
  });

  it("flags a fixed-query-string GraphQL candidate whose operationName occurs only once among many distinct one-off operationName groups sharing the endpoint", () => {
    const buildOccurrence = (i: number, operationName: string) => ({
      method: "POST",
      url: "https://apply.acme.example/graphql?v=1",
      requestPostData: JSON.stringify({ operationName, variables: { i } }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { results: [{ id: `item-${i}` }] },
      operationName,
    });
    const first = buildOccurrence(0, "getViewer");
    const occurrences = [
      first,
      ...Array.from({ length: 10 }, (_, i) => buildOccurrence(i + 1, `op${i}`)),
    ];
    expect(occurrences.length).toBe(11);
    expect(isZeroVarianceRepeatCapture(first, occurrences)).toBe(true);
  });
});

describe("ERROR_SINK_PATH_SEGMENT", () => {
  it("matches a whole error/errors segment only", () => {
    expect(ERROR_SINK_PATH_SEGMENT.test("/error")).toBe(true);
    expect(ERROR_SINK_PATH_SEGMENT.test("/api/errors/report")).toBe(true);
    expect(ERROR_SINK_PATH_SEGMENT.test("/error-codes")).toBe(false);
  });
});
