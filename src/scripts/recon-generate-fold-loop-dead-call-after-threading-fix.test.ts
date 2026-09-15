import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Pins the residual noted alongside bugfix-002 (the `findThreadedJoinFields`
 * name-correlation gate on fold/drill-loop threading, see
 * recon-generate-fold-drill-loop-value-coincidence-threading-guard-runtime-e2e.test.ts):
 * before that fix, `findThreadedJoinFields` didn't just splice a
 * differently-named field into an EXISTING drill's body — it also let a
 * wholly UNRELATED, site-agnostic feature-toggle-shaped call become its own
 * bogus fold TARGET whenever its own request happened to value-equal a
 * primary item's unrelated field, firing it once PER PRIMARY ITEM inside the
 * loop and merging its response fields onto every item via `Object.assign`.
 * Verified directly against the pre-fix `findThreadedJoinFields` (checked out
 * from commit a5c6e5d^) with this exact fixture: it emitted a `foldItems`
 * loop whose body issued `httpClient` calls to BOTH `/config/feature-toggles/`
 * (once per item, via `r1`) AND the real `/catalog/room-detail/` drill,
 * merging `r1`'s response into every item.
 *
 * Once the correlation gate is in place, the toggle call no longer resolves
 * `findThreadedJoinFields(...).length > 0` against the item's own field (the
 * toggle's `toggleCheck` key does not correlate with `displayOrder`), so
 * `scanPrimaryCandidateGroups` never admits it as a fold target at all —
 * it falls through to an ordinary standalone step, called exactly ONCE
 * (not once per item), and — since nothing downstream reads its response —
 * left UNBOUND (`await httpClient(...)`, no `const rN = ...`) by the same
 * `referencedNames`-gated produce/bind suppression `emitMultiStepExecuteHttp`
 * already applies to every step (recon-generate.ts's `bindResponse`/
 * `produceLines` gating, ~L6547-6561). No additional pruning is needed: the
 * generator's existing machinery already keeps this call out of the resolved
 * fold chain and never binds its now-unreferenced response to a variable —
 * this test is verification-only.
 */

const SEARCH_URL = "https://api.example.com/catalog/search/";
const DRILL_URL = "https://api.example.com/catalog/room-detail/";
const TOGGLE_URL = "https://api.example.com/config/feature-toggles/";

// Same two-item shape as the value-coincidence threading guard fixture: each
// item's own deep, unrelated `displayOrder` differs per item (105 vs 205),
// so a wrongly-per-item-threaded call is externally distinguishable from a
// single standalone call.
const SEARCH_BODY = {
  results: [
    { sku: "sku-a", meta: { ranking: { displayOrder: 105 } } },
    { sku: "sku-b", meta: { ranking: { displayOrder: 205 } } },
  ],
};

function buildFixtureCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    buildCapture({
      url: SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: SEARCH_BODY,
      timestamp: "2024-11-15T00:00:00Z",
    }),
    // The extra, unrelated feature-toggle-shaped capture: its own recorded
    // request body coincidentally value-equals sku-a's unrelated
    // `displayOrder` (105), under a DIFFERENTLY-named key (`toggleCheck`) —
    // the exact shape `keyNamesCorrelate` must reject.
    buildCapture({
      url: TOGGLE_URL,
      requestPostData: '{"toggleCheck":105}',
      responseBody: { enabled: true, cohort: "on" },
      timestamp: "2024-11-15T00:00:00.5Z",
    }),
    buildCapture({
      url: DRILL_URL,
      requestPostData: '{"sku":"sku-a","filters":{"page":105,"exploreMorePage":105}}',
      responseBody: {
        detailToken: "detail-token-sku-a",
        rooms: [{ sku: "sku-a", price: 199.99 }],
      },
      timestamp: "2024-11-15T00:00:01Z",
    }),
  ];
}

describe("recon-generate fold/drill-loop — dead call after value-coincidence threading fix", () => {
  it("never folds an unrelated feature-toggle-shaped call into the per-item loop, and never binds its unreferenced response to a variable", () => {
    const captures = buildFixtureCaptures();
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

    // The toggle call must be fired exactly once — a single top-level
    // `httpClient` call to its endpoint, never inside the `for (const item of
    // foldItems)` loop body (pre-fix, this exact fixture emits it as `r1`,
    // fetched once per item, inside the loop, with an `Object.assign(item,
    // ...)` merge of its response).
    const toggleCallCount = (body.match(/config\/feature-toggles\//g) ?? []).length;
    expect(toggleCallCount).toBe(1);
    expect(body).not.toMatch(
      /foldItems[\s\S]*config\/feature-toggles\/[\s\S]*catalog\/room-detail\//
    );

    // Its response is never bound to a variable — nothing downstream reads
    // it, so `emitMultiStepExecuteHttp`'s referencedNames-gated bind
    // suppression must leave it a bare, unbound call.
    expect(body).toMatch(/await httpClient\(`\$\{payload\.BaseUrl\}\/config\/feature-toggles\/`/);
    expect(body).not.toMatch(
      /const \w+ = \(await httpClient\(`\$\{payload\.BaseUrl\}\/config\/feature-toggles\/`/
    );

    // No `Object.assign` merge sources the toggle's response fields
    // (`enabled`/`cohort`) onto any item.
    expect(body).not.toMatch(/Object\.assign\(item,[\s\S]*?(enabled|cohort)/);

    // The genuine per-item drill (joined on `sku`) still resolves correctly
    // and unregressed, exactly as the value-coincidence threading guard test
    // pins.
    expect(body).toMatch(
      /foldMatches\.find\(\(m\) => String\(m\["sku"\]\) === String\(item\.sku\)\)/
    );
  });
});
