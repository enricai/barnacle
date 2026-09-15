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
 * Pins bugfix-002: `findThreadedJoinFields` (recon-generate.ts) widens a
 * per-item fold/drill loop's threaded fields beyond `target.joinFields` by
 * bare VALUE equality against the drill capture's own recorded request text
 * — with no check that the source item field's own name plausibly names the
 * same coordinate as the differently-named request-body key it lands under.
 * This is the genuine multi-item fold-loop shape the report's real-world
 * repro hit (a `for (const g0 of ...)` primary loop, each iteration issuing
 * its own per-item drill call): a primary item carries a deeply-nested,
 * unrelated scalar (`meta.ranking.displayOrder`, the fixture's stand-in for
 * the report's `stateroomTypes[...].displayOrder.displayOrder`) that
 * coincidentally equals the SAME recorded drill request's own NESTED
 * `filters.page` AND `filters.exploreMorePage` literals — two
 * differently-named fields with nothing to do with "displayOrder". (Nested,
 * not top-level: a top-level scalar body key is unconditionally
 * payload-ified by `applyPayloadKeyValueSubstitutions` before this fold
 * branch ever runs, which would mask the coincidence this test targets —
 * confirmed by running this exact fixture against the pre-fix
 * `findThreadedJoinFields`, which spliced `exploreMorePage` from the
 * unrelated `displayOrder` accessor.) Neither nested field may ever be
 * spliced from that accessor; the drill call must still succeed for every
 * primary item via the genuinely name-correlated `sku` join field alone
 * (the existing `recon-generate-1-12-50-*` guard tests already pin that
 * legitimate same-name threading — token reused verbatim — survives this
 * fix unregressed).
 */

const SEARCH_URL = "https://api.example.com/catalog/search/";
const DRILL_URL = "https://api.example.com/catalog/room-detail/";

// Two primary items, each with its own per-item drill/detail call — the
// genuine multi-item fold-loop shape (not a single-item degenerate case).
// Each item's deep, unrelated `displayOrder` value differs per item, so a
// wrong per-item threading (as opposed to a single frozen literal) would be
// externally distinguishable.
const SEARCH_BODY = {
  results: [
    { sku: "sku-a", meta: { ranking: { displayOrder: 105 } } },
    { sku: "sku-b", meta: { ranking: { displayOrder: 205 } } },
  ],
};

// Recorded only for the first item (sku-a) — the real interaction this fold
// plan is built from. `filters.page` and `filters.exploreMorePage` are two
// DIFFERENTLY-NAMED nested fields whose recorded literal (105) coincidentally
// equals sku-a's own deep, unrelated `meta.ranking.displayOrder` — mirroring
// the report's `page`/`exploreMorePage` both wrongly receiving
// `displayOrder105`.
const DRILL_BODY_FOR = (
  sku: string
): { detailToken: string; rooms: Array<Record<string, unknown>> } => ({
  detailToken: `detail-token-${sku}`,
  rooms: [{ sku, price: 199.99 }],
});

function buildRecordedFoldDrillLoopCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    buildCapture({
      url: SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: SEARCH_BODY,
      timestamp: "2024-11-15T00:00:00Z",
    }),
    buildCapture({
      url: DRILL_URL,
      requestPostData: '{"sku":"sku-a","filters":{"page":105,"exploreMorePage":105}}',
      responseBody: DRILL_BODY_FOR("sku-a"),
      timestamp: "2024-11-15T00:00:01Z",
    }),
  ];
}

/**
 * Stubs `fetch` for the fold-drill loop: the primary search call, then one
 * drill call per primary item, matched by request body content (the `sku`
 * field), not call order.
 */
function stubFoldDrillLoopFetch(): void {
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (requestBody === null || typeof requestBody.page === "number") return SEARCH_BODY;
      if (typeof requestBody.sku === "string") return DRILL_BODY_FOR(requestBody.sku);
      throw new Error(
        `stubFoldDrillLoopFetch: unrecognized request body ${JSON.stringify(requestBody)}`
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

describe("recon-generate fold/drill-loop executeHttp — value-coincidence threading guard", () => {
  it("never sources a differently-named nested drill-request field from an item's unrelated deep value that merely coincides in the recorded request text", async () => {
    const captures = buildRecordedFoldDrillLoopCaptures();
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

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

    // The emitted per-item drill call must never source the nested "page" or
    // "exploreMorePage" fields from the item's own unrelated `displayOrder`
    // accessor — neither field name plausibly names the same concept as
    // "displayOrder", so the value-equality-only match must be rejected.
    // Pre-fix, this exact fixture emits
    // `"exploreMorePage":${((item.meta as ...).ranking as ...).displayOrder}`.
    expect(body).not.toMatch(/"page"\s*:\s*\$\{[^}]*displayOrder[^}]*\}/i);
    expect(body).not.toMatch(/"exploreMorePage"\s*:\s*\$\{[^}]*displayOrder[^}]*\}/i);
    expect(body).not.toMatch(/room-detail\/[\s\S]*?displayOrder/);

    // The join field genuinely proven by the drill's own recorded request
    // (`sku`, present on both the item and the request) must still resolve
    // the fold match — the fix must not over-correct into leaving every
    // fold match unresolvable.
    expect(body).toMatch(
      /foldMatches\.find\(\(m\) => String\(m\["sku"\]\) === String\(item\.sku\)\)/
    );

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(body).not.toMatch(/\$\{[^}]*\$\{/);

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubFoldDrillLoopFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({
      BaseUrl: "https://api.example.com",
      page: 1,
      filters: { page: 105, exploreMorePage: 105 },
    });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toHaveLength(2);
    // Both items resolve their own drill call — folded fields (`price`) land
    // on both, purely via the genuine `sku` join, regardless of the
    // never-threaded `filters` object.
    expect(data.results?.[0]).toMatchObject({ sku: "sku-a", price: 199.99 });
    expect(data.results?.[1]).toMatchObject({ sku: "sku-b", price: 199.99 });

    // One primary call, plus one drill call per primary item (2).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2);
  });
});
