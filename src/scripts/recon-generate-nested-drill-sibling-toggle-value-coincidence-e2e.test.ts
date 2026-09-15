import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Combines the report's two remaining defect-2 leakage sources into ONE
 * fixture, since `collectDependentDrillDownChainValues` and
 * `findThreadedJoinFields` are both scoped to a single detected
 * chain/fold-target and may not catch cross-chain leakage the same way each
 * catches an in-chain coincidence alone:
 *
 * (a) a value hoisted via a FIXED, constant array-index path into the
 *     PRIMARY (search) capture's OWN response — reused identically on every
 *     fold-loop iteration — coincidentally equals a differently-named
 *     nested drill-body field (mirrors the report's
 *     `stateroomTypes[...].displayOrder.displayOrder` leaking into `page`).
 * (b) a genuinely SEPARATE, non-chain capture (a feature-toggle read with no
 *     join key connecting it to the primary/drill/submit chain at all,
 *     fired before the chain even starts) whose boolean fields
 *     coincidentally equal the TRUE literal values of two differently-named
 *     submit-body fields at once (mirrors the report's
 *     `toggles/product-avail` response leaking `enableHomepageLocaleStorage`
 *     into both `accessible` and `pageHistory`).
 *
 * Neither `recon-generate-frozen-value-and-multi-target-coincidence-guard-runtime-e2e.test.ts`
 * (frozen value lives on a per-item field, no sibling out-of-chain capture)
 * nor `recon-generate-primary-capture-frozen-index-value-multi-target-threading-guard-e2e.test.ts`
 * (frozen primary-index leak alone, no sibling capture) exercises the
 * combination of an in-primary frozen-index leak AND a leak from a capture
 * entirely outside the detected fold/drill chain in the same flow.
 */

const TOGGLES_URL = "https://api.example.com/config/feature-toggles/";
const SEARCH_URL = "https://api.example.com/catalog/search/";
const DRILL_URL = "https://api.example.com/catalog/room-detail/";
const SUBMIT_URL = "https://api.example.com/catalog/submit/";

const DETAIL_TOKEN_VALUE = "detail-token-item-a";

// A constant read from a FIXED literal index into the PRIMARY capture's own
// response — NOT any loop item's own field — reused identically on every
// fold iteration.
const FROZEN_PRIMARY_INDEX_VALUE = 731;

const SEARCH_BODY = {
  results: [{ itemId: "item-a" }, { itemId: "item-b" }],
  meta: {
    catalogInfo: {
      "3": { tierInfo: { tierInfo: FROZEN_PRIMARY_INDEX_VALUE } },
    },
  },
};

// `acceptsGuest` is genuinely name-correlated with the submit body's own
// `acceptsGuest` field, so the toggle response is legitimately kept in
// scope as a used state variable. `enableFastLane` has NO name-correlated
// target anywhere downstream — it exists purely so a differently-named
// field can coincidentally match its boolean VALUE instead.
const TOGGLES_BODY = { acceptsGuest: true, enableFastLane: true };

const DRILL_BODY_FOR = (itemId: string): { detailToken: string; itemId: string } => ({
  detailToken: DETAIL_TOKEN_VALUE,
  itemId,
});

function buildNestedDrillSiblingToggleCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    // (b) A separate feature-toggle read with no join key linking it to
    // anything downstream — fired before the chain even begins.
    buildCapture({
      url: TOGGLES_URL,
      requestPostData: "[]",
      responseBody: TOGGLES_BODY,
      timestamp: "2026-02-01T00:00:00Z",
    }),
    buildCapture({
      url: SEARCH_URL,
      requestPostData: '{"resultPage":1}',
      responseBody: SEARCH_BODY,
      timestamp: "2026-02-01T00:00:01Z",
    }),
    // Only ONE per-item drill call is ever recorded (item-a) — the fold
    // plan must synthesize the rest from item data. `page` and
    // `exploreMorePage` are TOP-LEVEL sibling fields (not nested under one
    // object, unlike the already-guarded `filters`-object shape), each
    // coincidentally equal to the frozen primary-response index value —
    // mirrors the report's own `"page":${displayOrder105},...,
    // "exploreMorePage":${displayOrder105}` siblings exactly. `page` and
    // `exploreMorePage` also SHARE the literal word "page" once split into
    // camelCase words, which is the exact shape `keyNamesCorrelate`'s
    // word-overlap check treats as a plausible same-concept correlation
    // despite naming two unrelated concepts (current page number vs. total
    // explorable-page count) — a name-correlation false positive, not a
    // true join field.
    buildCapture({
      url: DRILL_URL,
      requestPostData: `{"itemId":"item-a","page":${FROZEN_PRIMARY_INDEX_VALUE},"exploreMorePage":${FROZEN_PRIMARY_INDEX_VALUE}}`,
      responseBody: DRILL_BODY_FOR("item-a"),
      timestamp: "2026-02-01T00:00:02Z",
    }),
    // The terminal submit call's own recorded body carries two
    // differently-named boolean fields whose TRUE literal coincidentally
    // matches the SEPARATE toggle capture's own boolean fields.
    buildCapture({
      url: SUBMIT_URL,
      requestPostData:
        '{"itemId":"item-a","detailToken":"' +
        DETAIL_TOKEN_VALUE +
        '","acceptsGuest":true,"pageHistory":true}',
      responseBody: { ok: true },
      timestamp: "2026-02-01T00:00:03Z",
    }),
  ];
}

function stubNestedDrillSiblingToggleFetch(): void {
  const fn = vi.fn().mockImplementation((url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (url.includes("feature-toggles")) return TOGGLES_BODY;
      if (requestBody === null || typeof requestBody.resultPage === "number") return SEARCH_BODY;
      if (typeof requestBody.itemId === "string" && "page" in requestBody) {
        return DRILL_BODY_FOR(requestBody.itemId as string);
      }
      if (url.includes("submit")) return { ok: true };
      throw new Error(
        `stubNestedDrillSiblingToggleFetch: unrecognized request ${url} ${JSON.stringify(requestBody)}`
      );
    })();
    return Promise.resolve({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify(responseBody)),
      headers: new Headers(),
    });
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate fold/drill-loop executeHttp — frozen primary-index leak plus a sibling out-of-chain toggle-capture value-coincidence leak", () => {
  it("never sources the drill body's page field from the frozen primary-response accessor, and never sources the submit body's boolean fields from the separate, out-of-chain toggle capture", async () => {
    const captures = buildNestedDrillSiblingToggleCaptures();
    const inputBody = JSON.parse(captures[1]!.requestPostData ?? "null") as unknown;

    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures);
    const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);

    const body = emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      inputBody,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map()
    );

    // (a) Neither "page" nor "exploreMorePage" may be sourced from the
    // frozen, iteration-invariant primary-response accessor — including via
    // a same-word ("page") false-positive name correlation between the two
    // differently-conceptual fields themselves.
    expect(body).not.toMatch(/"page"\s*:\s*\$\{[^}]*tierInfo[^}]*\}/i);
    expect(body).not.toMatch(/"exploreMorePage"\s*:\s*\$\{[^}]*tierInfo[^}]*\}/i);
    expect(body).not.toMatch(/room-detail\/[\s\S]*?tierInfo/);
    const pageMatch = body.match(/"page"\s*:\s*"?\$\{([^}]*)\}"?/);
    const exploreMorePageMatch = body.match(/"exploreMorePage"\s*:\s*"?\$\{([^}]*)\}"?/);
    if (pageMatch && exploreMorePageMatch) {
      expect(pageMatch[1]).not.toBe(exploreMorePageMatch[1]);
    }

    // (b) "pageHistory" is NOT itself a field on the toggle capture's
    // response — it must never be sourced from the toggle response's
    // UNRELATED `enableFastLane` accessor just because the two happen to
    // share the same boolean literal at generation time. (`acceptsGuest`
    // legitimately correlates by name with the toggle response's own
    // `acceptsGuest` field, so the toggle response staying in scope as a
    // used variable is correct — the bug is `pageHistory` also resolving
    // to that same in-scope variable's unrelated field.)
    expect(body).not.toMatch(/"pageHistory"\s*:\s*\$\{[^}]*enableFastLane[^}]*\}/i);
    const pageHistoryMatch = body.match(/"pageHistory"\s*:\s*"?\$\{([^}]*)\}"?/);
    const acceptsGuestMatch = body.match(/"acceptsGuest"\s*:\s*"?\$\{([^}]*)\}"?/);
    if (pageHistoryMatch && acceptsGuestMatch) {
      expect(pageHistoryMatch[1]).not.toBe(acceptsGuestMatch[1]);
    }

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(body).not.toMatch(/\$\{[^}]*\$\{/);

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubNestedDrillSiblingToggleFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({
      BaseUrl: "https://api.example.com",
      resultPage: 1,
      page: FROZEN_PRIMARY_INDEX_VALUE,
      exploreMorePage: FROZEN_PRIMARY_INDEX_VALUE,
      acceptsGuest: true,
      pageHistory: true,
    });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toHaveLength(2);
  });
});
