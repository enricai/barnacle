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
 * Combines the report's two remaining defect-2 shapes into the SAME
 * fold/drill-loop fixture, both of which must be rejected by the SAME
 * correlation decision in `findThreadedJoinFields`/`keyNamesCorrelate`
 * (recon-generate.ts), not by two separate ad hoc checks:
 *
 * (a) a numeric value that stays the SAME literal on every fold-loop
 *     iteration (the fixture's stand-in for a value hoisted via a constant,
 *     fixed-index path into the PRIMARY capture's response, which is
 *     likewise identical across iterations rather than varying per item —
 *     mirrors the report's frozen `stateroomTypes[...].displayOrder.displayOrder`)
 *     coincidentally equals the recorded drill request's own `filters.page`
 *     literal.
 * (b) a SINGLE boolean item field coincidentally equals the SAME recorded
 *     drill request's own TWO differently-named nested literals at once
 *     (`filters.accessible` AND `filters.pageHistory`) — mirrors the
 *     report's `enableHomepageLocaleStorage` leaking into both `accessible`
 *     and `pageHistory`).
 *
 * Sibling to recon-generate-fold-drill-loop-value-coincidence-threading-guard-runtime-e2e.test.ts
 * (which pins the single-target, per-item-varying case) and
 * recon-generate-value-coincidence-single-source-multi-target-field-guard.test.ts
 * (which pins the non-fold, linear-chain multi-target case) — this fixture
 * is the one shape neither sibling covers alone: a frozen (iteration-
 * invariant) value AND a single-source/multi-target collision inside the
 * SAME genuine multi-item fold loop. The drill call must still succeed for
 * every primary item via the genuinely name-correlated `sku` join field.
 */

const SEARCH_URL = "https://api.example.com/catalog/search/";
const DRILL_URL = "https://api.example.com/catalog/room-detail/";

// Two primary items whose `meta.ranking.displayOrder` is the SAME on both —
// the frozen-value stand-in — and whose `meta.flags.isFeatured` is likewise
// identical, distinguishing this fixture from the varying-per-item sibling.
const SEARCH_BODY = {
  results: [
    { sku: "sku-a", meta: { ranking: { displayOrder: 105 }, flags: { isFeatured: true } } },
    { sku: "sku-b", meta: { ranking: { displayOrder: 105 }, flags: { isFeatured: true } } },
  ],
};

// Recorded only for the first item (sku-a). `filters.page` coincidentally
// equals the frozen `displayOrder`; `filters.accessible` AND
// `filters.pageHistory` BOTH coincidentally equal the frozen `isFeatured`
// boolean — one source, two differently-named targets at once.
const DRILL_BODY_FOR = (
  sku: string
): { detailToken: string; rooms: Array<Record<string, unknown>> } => ({
  detailToken: `detail-token-${sku}`,
  rooms: [{ sku, price: 199.99 }],
});

function buildFrozenValueAndMultiTargetCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    buildCapture({
      url: SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: SEARCH_BODY,
      timestamp: "2024-11-15T00:00:00Z",
    }),
    buildCapture({
      url: DRILL_URL,
      requestPostData:
        '{"sku":"sku-a","filters":{"page":105,"accessible":true,"pageHistory":true}}',
      responseBody: DRILL_BODY_FOR("sku-a"),
      timestamp: "2024-11-15T00:00:01Z",
    }),
  ];
}

function stubFrozenValueAndMultiTargetFetch(): void {
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (requestBody === null || typeof requestBody.page === "number") return SEARCH_BODY;
      if (typeof requestBody.sku === "string") return DRILL_BODY_FOR(requestBody.sku);
      throw new Error(
        `stubFrozenValueAndMultiTargetFetch: unrecognized request body ${JSON.stringify(requestBody)}`
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

describe("recon-generate fold/drill-loop executeHttp — frozen-value and single-source multi-target value-coincidence guard", () => {
  it("never sources differently-named nested drill-request fields from an item field that stays constant across every fold iteration, including when one such field coincidentally matches two target keys at once", async () => {
    const captures = buildFrozenValueAndMultiTargetCaptures();
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

    // (a) "page" must never source from the frozen, iteration-invariant
    // `displayOrder` accessor.
    expect(body).not.toMatch(/"page"\s*:\s*\$\{[^}]*displayOrder[^}]*\}/i);
    // (b) Neither "accessible" nor "pageHistory" may source from the
    // frozen, iteration-invariant `isFeatured` accessor — a single source
    // threaded into two differently-named targets at once.
    expect(body).not.toMatch(/"accessible"\s*:\s*\$\{[^}]*isFeatured[^}]*\}/i);
    expect(body).not.toMatch(/"pageHistory"\s*:\s*\$\{[^}]*isFeatured[^}]*\}/i);
    expect(body).not.toMatch(/room-detail\/[\s\S]*?displayOrder/);
    expect(body).not.toMatch(/room-detail\/[\s\S]*?isFeatured/);

    // Even if "accessible" and "pageHistory" each independently resolved to
    // some other accessor, they may never both resolve to the exact SAME
    // single-source placeholder.
    const accessibleMatch = body.match(/"accessible"\s*:\s*"?\$\{([^}]*)\}"?/);
    const pageHistoryMatch = body.match(/"pageHistory"\s*:\s*"?\$\{([^}]*)\}"?/);
    if (accessibleMatch && pageHistoryMatch) {
      expect(accessibleMatch[1]).not.toBe(pageHistoryMatch[1]);
    }

    // The join field genuinely proven by the drill's own recorded request
    // (`sku`) must still resolve the fold match.
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

    stubFrozenValueAndMultiTargetFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({
      BaseUrl: "https://api.example.com",
      page: 1,
      filters: { page: 105, accessible: true, pageHistory: true },
    });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toHaveLength(2);
    expect(data.results?.[0]).toMatchObject({ sku: "sku-a", price: 199.99 });
    expect(data.results?.[1]).toMatchObject({ sku: "sku-b", price: 199.99 });

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2);
  });
});
