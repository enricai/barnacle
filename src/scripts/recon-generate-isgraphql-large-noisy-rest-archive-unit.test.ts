import { describe, expect, it } from "vitest";
import { isGraphQL } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Direct unit reproduction of the bugfix-001 cascade fixture's
 * misclassification: thousands of identical-response own-backend REST
 * captures collapse to a single rescued anti-vote while a much smaller set
 * of genuinely-varying same-host GraphQL captures keeps full per-capture
 * weight, letting raw count — not real traffic share — flip the
 * classification. See recon-generate-large-noisy-rest-archive-nested-fold-
 * submit-classification-compile-cascade-e2e.test.ts for the full CLI-level
 * reproduction this pins at the isGraphQL() level directly.
 */

const PRIMARY_HOST = "api.fleet-rental-fixture.example.org";
const AUTH_HOST = "sso.fleet-portal-fixture.example.net";

function restCapture(overrides: {
  method: string;
  url: string;
  requestPostData: string | null;
  responseBody: unknown;
}): Capture {
  return {
    timestamp: "2026-08-18T10:00:00.000Z",
    phase: "action",
    method: overrides.method,
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData,
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams:
      overrides.requestPostData !== null ? JSON.parse(overrides.requestPostData) : null,
  };
}

function graphqlCapture(overrides: {
  url: string;
  operationName: string;
  query: string;
  responseBody: unknown;
}): Capture {
  return {
    timestamp: "2026-08-18T10:00:00.000Z",
    phase: "home",
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      operationName: overrides.operationName,
      query: overrides.query,
    }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: overrides.operationName,
    query: overrides.query,
    variables: null,
    decodedParams: null,
  };
}

function buildFixtureCaptures(): Capture[] {
  const captures: Capture[] = [];

  for (let i = 0; i < 3000; i++) {
    captures.push(
      restCapture({
        method: "GET",
        url: `https://${PRIMARY_HOST}/api/fleet/browse`,
        requestPostData: null,
        responseBody: { items: ["fixed-fleet-listing"] },
      })
    );
  }

  captures.push(
    restCapture({
      method: "GET",
      url: `https://${PRIMARY_HOST}/api/fleet/fleet-availability?market=west`,
      requestPostData: null,
      responseBody: { locations: [] },
    })
  );

  for (let i = 0; i < 18; i++) {
    captures.push(
      restCapture({
        method: "POST",
        url: `https://${PRIMARY_HOST}/api/fleet/reserve-vehicle`,
        requestPostData: JSON.stringify({ reservationId: `reservation-${i}` }),
        responseBody: { status: "confirmed", reservationId: `reservation-${i}` },
      })
    );
  }

  for (let i = 0; i < 60; i++) {
    captures.push(
      graphqlCapture({
        url: `https://${PRIMARY_HOST}/graphql`,
        operationName: `FacetSearch${i}`,
        query: `query FacetSearch${i} { facets { id, label } }`,
        responseBody: { data: { facets: [{ id: `facet-${i}`, label: `Facet ${i}` }] } },
      })
    );
  }

  return captures;
}

describe("isGraphQL() — large noisy REST archive with a smaller set of distinct same-host GraphQL captures", () => {
  it("classifies as REST, not GraphQL, when thousands of collapsed-identical REST captures outweigh a numerically smaller set of distinct GraphQL captures", () => {
    const captures = buildFixtureCaptures();
    expect(isGraphQL(captures, [PRIMARY_HOST, AUTH_HOST], null, PRIMARY_HOST)).toBe(false);
  });
});
