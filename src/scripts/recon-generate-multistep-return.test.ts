import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, selectEffectiveResponseBody } from "@/scripts/recon-generate";
import {
  buildMulticallDependentDrillDownActionSteps,
  buildMulticallHeterogeneousActionSteps,
  buildMulticallHeterogeneousActionStepsWithDrillDown,
  buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps,
  buildMulticallSingleShotSearchDrillDownPathThreadedJoinActionSteps,
  buildStep,
  type MulticallFixtureStep,
} from "@/scripts/recon-generate-multicall-fixture";

/** `emitMultiStepExecuteHttp` takes the unexported `ActionStep[]`; the shared
 * fixture's `MulticallFixtureStep` is structurally identical except for
 * `produces` (`unknown[]` vs. the real `Produce[]`, always empty here), so a
 * type-only cast through the emitter's own parameter type is safe. */
function emit(steps: MulticallFixtureStep[]): string {
  return emitMultiStepExecuteHttp(
    steps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
    null,
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
}

describe("emitMultiStepExecuteHttp — G1 return-value selection", () => {
  it("folds the terminal drill-down's per-item response onto the re-queried search step, rather than discarding it", () => {
    const body = emit(buildMulticallHeterogeneousActionStepsWithDrillDown());

    // r4 (available-units/) threads r2's `products[0].productId` ("p1") into
    // its own request — a detected fold plan — so the return must reference
    // r2 (the primary array actually folded onto), not r3 (selectReturnAction's
    // plain "latest re-queried call" pick, which has no relation to what r4
    // threaded) and not r4's own raw body (the original defect: the drill-down
    // was fetched and its data discarded).
    expect(body).toContain("return { data: r2 };");
    expect(body).not.toContain("return { data: r3 };");
    expect(body).not.toContain("return { data: r4 };");
    expect(body).toContain("const r2 = (await httpClient(");
    expect(body).toContain("for (const item of foldItems) {");
    expect(body).toContain("Object.assign(item, foldMatches[0] ?? {});");
  });

  it("folds a single-shot (non-requeried) search's drill-down onto its results with no foldReturn declaration", () => {
    // detectDrillDownFoldPlan alone (structural heuristic, no FoldReturnSpec)
    // must recognize this primary even though its search endpoint fires
    // exactly once — the requeried-primary case above only proves the fold
    // fires when findRequeriedActions already flagged the primary as a
    // candidate; this fixture has no re-query at all.
    const steps = buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps();
    const body = emit(steps);

    expect(body).toContain("for (const item of foldItems) {");
    expect(body).toContain("Object.assign(item, foldMatches[0] ?? {});");
    expect(body).toContain("return { data: r0 };");

    const replayBody = { unused: true };
    const effectiveResponseBody = selectEffectiveResponseBody(true, steps, replayBody);

    expect(effectiveResponseBody).toEqual({
      results: [{ sku: "sku-a", amount: 19.99 }, { sku: "sku-b" }],
    });
  });

  it("folds a drill-down whose join key is threaded only as a URL path segment", () => {
    // detectDrillDownFoldPlan only resolves this shape because
    // collectRequestStringValues now scans URL path segments as
    // join-candidate values (accountId reaches the drill-down only via
    // `/accounts/42/transactions`, never a query param or JSON body value).
    // This proves the resolved plan actually reaches the emitter and
    // produces a real fold loop, not just that detection succeeds.
    const body = emit(buildMulticallSingleShotSearchDrillDownPathThreadedJoinActionSteps());

    expect(body).toContain("for (const item of foldItems) {");
    expect(body).toContain("Object.assign(item, foldMatches[0] ?? {});");
    expect(body).toContain("return { data: r0 };");
    expect(body).not.toContain("return { data: r1 };");
  });

  it("refuses to emit when a later step threads a produced value out of the fold drill step's own response", () => {
    // r4 (available-units/) is the fold plan's drill step. Its own
    // `units[0].unitId` is declared as a produce here — the same way a
    // chained call's threaded id normally reaches a later step — and step 5
    // threads it. `const r4` (and any produce read off it) is declared
    // inside the fold loop's block scope, so a reference from step 5
    // (outside that loop) can't resolve — emitting that would be broken
    // TypeScript, so this must fail loudly at generation time instead.
    const withDrillDown = buildMulticallHeterogeneousActionStepsWithDrillDown();
    const drillStep = withDrillDown[withDrillDown.length - 1]!;
    const steps: MulticallFixtureStep[] = [
      ...withDrillDown.slice(0, -1),
      {
        ...drillStep,
        produces: [
          { kind: "body", name: "unitId", path: ["units", "0", "unitId"] },
        ] as unknown as never[],
      },
      buildStep("r5", {
        url: "https://api.example.com/listings-avail-api/units/s1/hold",
        requestPostData: '{"unitId":"s1"}',
        responseBody: { held: true },
        timestamp: "2024-01-01T00:00:05Z",
      }),
    ];

    expect(() => emit(steps)).toThrow(/fold plan drill step r4 is referenced outside/);
  });

  it("still returns the search step when it is ALSO the terminal call", () => {
    const body = emit(buildMulticallHeterogeneousActionSteps());

    // Same re-queried available-products/ call (r3), now also last in the
    // sequence. Pinning this alongside the drill-down case proves the fix
    // tracks relevance, not merely a shifted position (e.g. "second-to-last").
    expect(body).toContain("return { data: r3 };");
    expect(body).toContain("const r3 = (await httpClient(");
  });

  it("returns the terminal call for a genuine 2-step submission flow with no re-queried endpoint", () => {
    const steps: MulticallFixtureStep[] = [
      {
        varName: "r0",
        produces: [],
        isMultipart: false,
        isCrossDomain: false,
        capture: {
          timestamp: "2024-01-01T00:00:00Z",
          phase: "action",
          method: "POST",
          url: "https://ats.example.com/api/applicants",
          status: 200,
          requestHeaders: { "Content-Type": "application/json" },
          requestPostData: '{"FirstName":"Reginald"}',
          responseHeaders: { "content-type": "application/json" },
          responseBody: { applicantId: "a1" },
          operationName: null,
          query: null,
          variables: null,
          decodedParams: null,
        },
      },
      {
        varName: "r1",
        produces: [],
        isMultipart: false,
        isCrossDomain: false,
        capture: {
          timestamp: "2024-01-01T00:00:01Z",
          phase: "action",
          method: "POST",
          url: "https://ats.example.com/api/applicants/a1/submit",
          status: 200,
          requestHeaders: { "Content-Type": "application/json" },
          requestPostData: '{"confirm":true}',
          responseHeaders: { "content-type": "application/json" },
          responseBody: { success: true },
          operationName: null,
          query: null,
          variables: null,
          decodedParams: null,
        },
      },
    ];

    // Neither endpoint is re-hit with a varying body, so findRequeriedActions
    // returns nothing and selectReturnAction must fall back to the LAST
    // action — not the first, which is selectPayloadAction's fallback. A fix
    // that naively reused selectPayloadAction's fallback would regress this
    // case to `return { data: r0 }`.
    const body = emit(steps);

    expect(body).toContain("return { data: r1 };");
    expect(body).not.toContain("return { data: r0 };");
    expect(body).toContain("const r1 = (await httpClient(");
  });

  it("resolves the drill step by join key rather than call order across multiple primary items", () => {
    // The primary page's items are [i-b, i-a] (index 0 is i-b); i-a's
    // drill-down (r2) fires BEFORE i-b's (r3). detectDrillDownFoldPlan now
    // scans every primary item (not just items[0]) for each candidate later
    // step, so it finds the earliest step that threads ANY item's join
    // value — r2, threading item index 1 (i-a) — rather than waiting for a
    // later step that happens to thread items[0]. Every loop iteration still
    // re-derives the join value from its own `item` rather than the single
    // sampled item the plan was detected from.
    const body = emit(buildMulticallDependentDrillDownActionSteps());

    expect(body).toContain(
      `const r2 = (await httpClient(\`\${payload.BaseUrl}/catalog/item-detail/\``
    );
    expect(body).toContain(`body: \`{"itemId":"\${item.itemId}"}\``);
    // r3 (i-b's own drill call) is not part of the fold — it's still
    // emitted as its own literal step — so only i-a (the value folded away
    // into the loop) must be absent from the emitted body.
    expect(body).not.toContain('"itemId":"i-a"');
  });

  it("re-derives a numeric-typed join field per loop iteration instead of hard-coding the sampled item's literal", () => {
    // accountId is a NUMBER on the primary item and is threaded into the
    // drill-down's JSON body as a number literal (not a string) — the
    // emitted loop must substitute `${item.accountId}` for the literal `42`
    // on every iteration, not leave `42` hard-coded from the single sampled
    // item detectDrillDownFoldPlan used to find the plan.
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/accounts/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: { accounts: [{ accountId: 42, name: "Acme" }] },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/accounts/detail",
        requestPostData: JSON.stringify({ accountId: 42 }),
        responseBody: { transactions: [{ transactionId: "t1" }] },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];

    const body = emit(steps);

    expect(body).toContain("for (const item of foldItems) {");
    expect(body).toContain(`body: \`{"accountId":\${item.accountId}}\``);
    expect(body).not.toContain('"accountId":42');
  });

  it("leaves the primary results unmerged, without crashing, when no later step threads the primary item's join key", () => {
    // Same primary page as the join-key test, but both later item-detail
    // calls carry a request body value that doesn't match either primary
    // item's itemId. findThreadedJoinFields then finds nothing to thread,
    // so detectDrillDownFoldPlan returns null and the generator must fall
    // back to its ordinary return-value selection instead of emitting a
    // fold loop it can't ground in evidence.
    const steps = buildMulticallDependentDrillDownActionSteps();
    const withUnthreadedDrills: MulticallFixtureStep[] = [
      ...steps.slice(0, 2),
      buildStep("r2", {
        url: "https://api.example.com/catalog/item-detail/",
        requestPostData: '{"itemId":"unrelated"}',
        responseBody: { details: [{ detailId: "d-a" }] },
        timestamp: "2024-03-01T00:00:02Z",
      }),
      buildStep("r3", {
        url: "https://api.example.com/catalog/item-detail/",
        requestPostData: '{"itemId":"also-unrelated"}',
        responseBody: { details: [{ detailId: "d-b" }] },
        timestamp: "2024-03-01T00:00:03Z",
      }),
    ];

    const body = emit(withUnthreadedDrills);

    expect(body).toContain("return { data: r3 };");
    expect(body).not.toContain("for (const item of foldItems) {");
    expect(body).not.toContain("Object.assign(item, foldMatches[0] ?? {});");
  });
});
