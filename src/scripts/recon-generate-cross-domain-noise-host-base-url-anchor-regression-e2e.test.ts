import { describe, expect, it } from "vitest";
import { registrableDomain } from "@/recon/capture-filters";
import {
  deriveBaseUrl,
  extractActionSequence,
  type FoldReturnSpec,
  isGraphQL,
  resolveFoldPlan,
  type SubmitPatterns,
} from "@/scripts/recon-generate";
import { buildCapture, buildStep } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Direct unit reproduction of the three downstream symptoms the report
 * describes (REST-vs-GraphQL misclassification, a declared
 * submitEndpointPattern/submitBodyPattern rejected despite real matches, and
 * a declared foldReturn joinFields rejected for a structurally-guessed key),
 * all traced to deriveBaseUrl anchoring on same-company noise whose host
 * label names it a marketing/landing bounce rather than an auth/login one —
 * the specific gap the no-declared-hosts anchor pick left open before this
 * fix (see deriveBaseUrl's own MARKETING_HOST_LABEL doc comment). Pins
 * isGraphQL, extractActionSequence, and resolveFoldPlan each agreeing with
 * the real backend once deriveBaseUrl anchors correctly, so this file is
 * independently runnable without re-deriving the fix itself.
 */

const PRIMARY_HOST = "api.catalog-fixture.example.com";
// Same-company, different-registrable-domain marketing/landing bounce — its
// first label ("www") matches the marketing vocabulary, not the auth one, so
// this exercises the generalized exclusion rather than the original
// auth-only one.
const MARKETING_HOST = "www.catalog-fixture-promo.example.net";

const SUBMIT_PATTERNS: SubmitPatterns = {
  endpoint: "catalog/confirm",
  body: null,
};

const FOLD_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/detail",
  resultsPath: "results",
  drillResultsPath: "details.items",
  joinFields: ["itemId"],
};

function buildCapturePool(): Capture[] {
  const captures: Capture[] = [];

  // The same-company marketing bounce lands FIRST in array order, purely due
  // to async completion timing — it must never anchor baseUrl/primaryHost.
  captures.push(
    buildCapture({
      url: `https://${MARKETING_HOST}/bounce`,
      method: "GET",
      requestPostData: null,
      responseBody: { redirected: true },
      timestamp: "2026-09-01T00:00:00.000Z",
    })
  );

  // The dominant own-backend REST host's listing capture, seeding the item
  // ids the declared foldReturn.resultsPath resolves against.
  captures.push(
    buildCapture({
      url: `https://${PRIMARY_HOST}/catalog/search/`,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { results: [{ itemId: "item-1" }, { itemId: "item-2" }] },
      timestamp: "2026-09-01T00:00:01.000Z",
    })
  );

  // Bulk own-backend read noise, unrelated to the declared submit pattern or
  // the join field — makes the dominant host genuinely dominant by count.
  for (let i = 0; i < 20; i++) {
    captures.push(
      buildCapture({
        url: `https://${PRIMARY_HOST}/catalog/availability`,
        method: "GET",
        requestPostData: null,
        responseBody: { slots: [`slot-${i}`] },
        timestamp: `2026-09-01T00:01:${String(i).padStart(2, "0")}.000Z`,
      })
    );
  }

  // Genuine submissions matching the declared submitEndpointPattern.
  captures.push(
    buildCapture({
      url: `https://${PRIMARY_HOST}/catalog/confirm`,
      requestPostData: JSON.stringify({ itemId: "item-1" }),
      responseBody: { status: "confirmed", itemId: "item-1" },
      timestamp: "2026-09-01T00:02:00.000Z",
    })
  );
  captures.push(
    buildCapture({
      url: `https://${PRIMARY_HOST}/catalog/confirm`,
      requestPostData: JSON.stringify({ itemId: "item-2" }),
      responseBody: { status: "confirmed", itemId: "item-2" },
      timestamp: "2026-09-01T00:02:01.000Z",
    })
  );

  // Declared foldReturn drill target: its URL threads a slot code, never the
  // declared join field — `joinFields: ["itemId"]` only ever appears in the
  // response body, forcing the response-only resolution path.
  captures.push(
    buildCapture({
      url: `https://${PRIMARY_HOST}/catalog/detail/slot-2`,
      method: "GET",
      requestPostData: null,
      responseBody: {
        details: { items: [{ itemId: "item-2", slotCode: "slot-2" }] },
      },
      timestamp: "2026-09-01T00:02:02.000Z",
    })
  );

  return captures;
}

describe("downstream agreement with the real backend once deriveBaseUrl anchors past same-company marketing noise", () => {
  const captures = buildCapturePool();
  // Deliberately called WITHOUT submitPatterns: a declared submitEndpointPattern
  // whose matches already live on the dominant host independently rescues the
  // anchor pick via deriveBaseUrl's crossDomainSubmitMatch carve-out, masking
  // the marketing-label anchor bug this test exists to pin. Omitting it here
  // isolates the anchor-pick fix itself, matching the convention of the
  // deriveBaseUrl unit tests added alongside it (src/scripts/recon-generate.test.ts).
  const baseUrl = deriveBaseUrl(captures, []);
  const primaryHost = baseUrl.length > 0 ? new URL(baseUrl).hostname : null;
  const fallbackDomain = primaryHost !== null ? registrableDomain(primaryHost) : null;

  it("deriveBaseUrl anchors on the dominant own-backend host, not the marketing bounce that sorts first", () => {
    expect(baseUrl).toBe(`https://${PRIMARY_HOST}`);
  });

  it("isGraphQL classifies the pool as REST once anchored on the real primary host", () => {
    expect(isGraphQL(captures, [], fallbackDomain, primaryHost)).toBe(false);
  });

  it("extractActionSequence's host-gated pool contains the declared-pattern-matching captures, not '0 capture(s)'", () => {
    const actions = extractActionSequence(
      captures,
      SUBMIT_PATTERNS,
      FOLD_SPEC,
      [],
      fallbackDomain,
      true,
      primaryHost
    );
    const submitMatches = actions.filter((a) => /catalog\/confirm/.test(a.capture.url));
    expect(submitMatches.length).toBeGreaterThan(0);
  });

  it("resolveFoldPlan resolves the declared joinFields rather than falling back to a structurally-guessed key", () => {
    const primarySteps = [
      buildStep("primary", {
        url: `https://${PRIMARY_HOST}/catalog/search/`,
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: { results: [{ itemId: "item-1" }, { itemId: "item-2" }] },
        timestamp: "2026-09-01T00:00:01.000Z",
      }),
      buildStep("drill-1", {
        url: `https://${PRIMARY_HOST}/catalog/detail/slot-1`,
        method: "GET",
        requestPostData: null,
        responseBody: {
          details: { items: [{ itemId: "item-1", slotCode: "slot-1" }] },
        },
        timestamp: "2026-09-01T00:02:00.000Z",
      }),
      buildStep("drill-2", {
        url: `https://${PRIMARY_HOST}/catalog/detail/slot-2`,
        method: "GET",
        requestPostData: null,
        responseBody: {
          details: { items: [{ itemId: "item-2", slotCode: "slot-2" }] },
        },
        timestamp: "2026-09-01T00:02:01.000Z",
      }),
    ];

    const plans = resolveFoldPlan(primarySteps, FOLD_SPEC, null);

    expect(plans.length).toBeGreaterThan(0);
    const allTargets = plans.flatMap((plan) => plan.targets);
    expect(allTargets.length).toBeGreaterThan(0);
    for (const target of allTargets) {
      expect(target.joinFields).toEqual(["itemId"]);
    }
  });
});
