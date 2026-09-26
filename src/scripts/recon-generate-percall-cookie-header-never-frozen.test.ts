import { describe, expect, it } from "vitest";
import {
  collectHeaderBindings,
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the per-call header builder's two unguarded loops (non-multipart and
 * multipart) so a captured `Cookie` header is never frozen into a generated
 * plugin's per-call headers, even partially. IGNORE_REQUEST_HEADERS already
 * excludes `cookie` from BASE_HEADERS derivation (recon-generate.ts:1195-
 * 1211) — these loops must apply the same exclusion, since a cookie jar
 * routinely mixes a coincidentally-threadable fragment (here, a facet value
 * also present in the request body) with session/analytics/JWT values never
 * produced by any prior step. A partial substring match on the threadable
 * fragment must never bake the rest of the jar in as a literal.
 */

const OWN_HOST = "api.percall-cookie-fixture.example.com";
const FACET_VALUE = "december-2026-promo";

/** Mixes a session id, an Adobe-Analytics-style cookie pair, and a
 * JWT-bearing cookie with the facet fragment that partial-matches the
 * registered payload accessor — none of these are Set-Cookie-response
 * origin values. */
function unboundCookieJar(): string {
  return [
    "sessionId=sess-9f8e7d6c5b4a3210",
    "AMCV_ADOBEORG=1234567890%7CMCIDTS%7C19999",
    "AMCVS_ADOBEORG=1",
    "ak_bmsc=AK_BMSC_LONG_OPAQUE_VALUE_1234567890ABCDEF",
    "__pa=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.signaturepart",
    `facetFilters=${FACET_VALUE},other-unrelated-value`,
  ].join("; ");
}

function searchCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: `https://${OWN_HOST}/catalog/search`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ facetFilters: FACET_VALUE }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { results: [{ itemId: "item-a" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function nonMultipartSubmitCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:01Z",
    phase: "action",
    method: "POST",
    url: `https://${OWN_HOST}/catalog/submit`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json", Cookie: unboundCookieJar() },
    requestPostData: JSON.stringify({ facetFilters: FACET_VALUE }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { ok: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function multipartUploadCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:02Z",
    phase: "action",
    method: "POST",
    url: `https://${OWN_HOST}/catalog/upload`,
    status: 200,
    requestHeaders: { "Content-Type": "multipart/form-data", Cookie: unboundCookieJar() },
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { ok: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

/** Legitimate counterpart: a genuine Set-Cookie-origin cookie minted by an
 * earlier step and echoed back verbatim on a later request — the ONLY
 * sanctioned path for a cookie value to thread. */
function tokenMintCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:03Z",
    phase: "action",
    method: "POST",
    url: `https://${OWN_HOST}/auth/mint`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: "{}",
    responseHeaders: { "set-cookie": "authToken=BOUND_SESSION_ABC123DEF456; Path=/; HttpOnly" },
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function boundCookieConsumerCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:04Z",
    phase: "action",
    method: "GET",
    url: `https://${OWN_HOST}/catalog/private`,
    status: 200,
    requestHeaders: {
      "Content-Type": "application/json",
      Cookie: "authToken=BOUND_SESSION_ABC123DEF456",
    },
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { products: [] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function emitBody(captures: Capture[], inputBody: unknown = { facetFilters: FACET_VALUE }): string {
  const stateIndex = indexStateValues(captures as never);
  const actionCaptures = captures.map((capture, index) => ({ capture, index }));
  const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);
  return emitMultiStepExecuteHttp(
    actionSteps,
    inputBody,
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    new Set(),
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    `https://${OWN_HOST}`,
    new Map(),
    new Map(),
    null,
    new Map(),
    new Map(),
    new Set(),
    [],
    new Map(),
    new Map(),
    null
  );
}

describe("emitMultiStepExecuteHttp — a captured Cookie header never freezes into a per-call literal", () => {
  it("non-multipart path: emits no Cookie/cookie header entry at all, not even the partially-interpolated facet fragment", () => {
    const body = emitBody([searchCapture(), nonMultipartSubmitCapture()]);

    expect(body).not.toMatch(/["']?[Cc]ookie["']?\s*:/);
    expect(body).not.toContain("sessionId=sess-9f8e7d6c5b4a3210");
    expect(body).not.toContain("AMCV_ADOBEORG");
    expect(body).not.toContain("ak_bmsc");
    expect(body).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9");
  });

  it("multipart path: emits no Cookie/cookie header entry at all, not even the partially-interpolated facet fragment", () => {
    const body = emitBody([searchCapture(), multipartUploadCapture()]);

    expect(body).not.toMatch(/["']?[Cc]ookie["']?\s*:/);
    expect(body).not.toContain("sessionId=sess-9f8e7d6c5b4a3210");
    expect(body).not.toContain("AMCV_ADOBEORG");
    expect(body).not.toContain("ak_bmsc");
    expect(body).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9");
  });

  it("a genuine Set-Cookie-origin-bound cookie still threads via the existing bind mechanism, unaffected by the per-call skip", () => {
    const captures = [tokenMintCapture(), boundCookieConsumerCapture()];
    const stateIndex = indexStateValues(captures as never);
    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);

    const headerBindings = collectHeaderBindings(actionSteps);
    const cookieBindings = headerBindings.filter((b) => b.targetHeader === "Cookie");
    expect(cookieBindings).toHaveLength(1);
    expect(cookieBindings[0]).toMatchObject({
      kind: "header",
      sourceHeader: "set-cookie",
      cookieName: "authToken",
      targetHeader: "Cookie",
    });

    // The per-call header builder still must not freeze the raw jar into a
    // literal — the bind mechanism above is the only path that carries it.
    const body = emitBody(captures, null);
    expect(body).not.toMatch(/["']?[Cc]ookie["']?\s*:/);
  });
});
