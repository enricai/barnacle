import { describe, expect, it } from "vitest";
import {
  detectDrillDownFoldPlan,
  emitMultiStepExecuteHttp,
  type FoldReturnSpec,
  parseFoldReturnSpec,
  resolveFoldPlan,
  selectEffectiveResponseBody,
} from "@/scripts/recon-generate";
import {
  buildMulticallDependentDrillDownActionSteps,
  buildMulticallHeterogeneousActionSteps,
  buildMulticallNestedGroupedDrillDownMultiGroupActionSteps,
  buildMulticallSingleShotSearchDrillDownActionSteps,
  buildMulticallSingleShotSearchDrillDownMultiMatchActionSteps,
  buildMulticallSingleShotSearchDrillDownTypeMismatchJoinActionSteps,
  buildMulticallSingleShotSearchHeuristicAndSpecTwoTargetActionSteps,
  buildStep,
  type MulticallFixtureStep,
} from "@/scripts/recon-generate-multicall-fixture";

/** Both sides of {@link buildMulticallSingleShotSearchDrillDownActionSteps}'s
 * decoy at once: a decoy `facets[]` array ahead of the real `results[]` on
 * the primary side, and a decoy `errors[]` array ahead of the real per-item
 * `details[]` on the drill side. Since the join value threads into the drill
 * request on both sides, `detectDrillDownFoldPlan`'s structural heuristic
 * resolves this on its own (see {@link buildUnthreadedDoubleDecoyDrillDownActionSteps}
 * for the variant that isolates `buildFoldPlanFromSpec`'s own DFS-first
 * fallback instead). */
function buildDoubleDecoyDrillDownActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: {
        facets: [{ name: "brand" }],
        results: [{ sku: "sku-a" }, { sku: "sku-b" }],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/pricing/",
      requestPostData: '{"sku":"sku-a"}',
      responseBody: {
        errors: [{ code: "none" }],
        details: [{ sku: "sku-a", price: 19.99 }],
      },
      timestamp: "2024-04-01T00:00:01Z",
    }),
  ];
}

/** Same double-decoy shape as {@link buildDoubleDecoyDrillDownActionSteps},
 * except the drill-down request never carries the join value anywhere the
 * structural heuristic can see it — so, unlike that fixture (which the
 * heuristic now resolves on its own via join-threading), the heuristic finds
 * nothing on either side and `buildFoldPlanFromSpec`'s own drill-side
 * DFS-first fallback is the only thing left to isolate. */
function buildUnthreadedDoubleDecoyDrillDownActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: {
        facets: [{ name: "brand" }],
        results: [{ sku: "sku-a" }, { sku: "sku-b" }],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/pricing/",
      requestPostData: '{"lookup":true}',
      responseBody: {
        errors: [{ code: "none" }],
        details: [{ sku: "sku-a", price: 19.99 }],
      },
      timestamp: "2024-04-01T00:00:01Z",
      requestHeaders: { "Content-Type": "application/json", "X-Item-Sku": "sku-a" },
    }),
  ];
}

/** A single-shot search + drill-down pair whose join value is threaded only
 * through a request HEADER, never through the URL or body —
 * `collectRequestStringValues` deliberately never scans headers, so the
 * structural heuristic has no threaded value to find on either candidate
 * array and only a flow-declared `foldReturn` (which must search headers
 * too) can resolve the fold. */
function buildUnthreadedJoinDrillDownActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/pricing/",
      requestPostData: '{"lookup":true}',
      responseBody: { prices: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
      requestHeaders: { "Content-Type": "application/json", "X-Item-Sku": "sku-a" },
    }),
  ];
}

/** Same header-threaded join as {@link buildUnthreadedJoinDrillDownActionSteps},
 * except the header carries the SECOND primary item's join value, not the
 * first — isolating `buildFoldPlanFromSpec`'s own item search (it must not
 * assume `primaryMatchedItemIndex` is always 0 just because a spec resolved
 * the plan). */
function buildHeaderThreadedNonFirstItemDrillDownActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/pricing/",
      requestPostData: '{"lookup":true}',
      responseBody: { prices: [{ sku: "sku-b", amount: 24.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
      requestHeaders: { "Content-Type": "application/json", "X-Item-Sku": "sku-b" },
    }),
  ];
}

/** A primary `results[]` array with TWO independent drill-downs: the first
 * (`/catalog/pricing/`) threads its join value into the request body, so
 * the structural heuristic resolves it on its own; the second
 * (`/catalog/inventory/`) carries its join value only in a header the
 * heuristic never inspects, so only a `foldReturn` spec naming it can
 * resolve it. Isolates the SAME-primary merge: the heuristic's plan and the
 * spec's plan must union onto one `targets` array, not OR against each
 * other. */
function buildPartiallyThreadedTwoDrillDownActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/pricing/",
      requestPostData: '{"sku":"sku-a"}',
      responseBody: { prices: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: "https://api.example.com/catalog/inventory/",
      requestPostData: '{"lookup":true}',
      responseBody: { stock: [{ sku: "sku-a", quantity: 7 }] },
      timestamp: "2024-04-01T00:00:02Z",
      requestHeaders: { "Content-Type": "application/json", "X-Item-Sku": "sku-a" },
    }),
  ];
}

/** Same header-threaded join shape, except the header carries a value that
 * matches no primary item at all — the fixture for the fails-closed case:
 * `buildFoldPlanFromSpec` must return `null` rather than guess index 0. */
function buildHeaderThreadedNoMatchDrillDownActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/pricing/",
      requestPostData: '{"lookup":true}',
      responseBody: { prices: [{ sku: "sku-z", amount: 24.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
      requestHeaders: { "Content-Type": "application/json", "X-Item-Sku": "sku-z" },
    }),
  ];
}

/** A single-shot search + drill-down pair joined on two fields (`accountId`
 * and `region`) rather than one, so composite `joinFields` declarations have
 * a fixture to resolve and emit against. */
function buildCompositeJoinActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/records/search",
      requestPostData: '{"page":1}',
      responseBody: {
        results: [
          { accountId: "acc-1", region: "us" },
          { accountId: "acc-2", region: "eu" },
        ],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/records/detail",
      requestPostData: '{"accountId":"acc-1","region":"us"}',
      responseBody: { details: [{ accountId: "acc-1", region: "us", balance: 100 }] },
      timestamp: "2024-04-01T00:00:01Z",
    }),
  ];
}

/** A primary response whose declared `resultsPath` threads through an array
 * index (`categories.0.products`) rather than a bare object key, isolating
 * `objectItemsAtPath`'s array-node traversal: the primary items to fold live
 * inside `categories[0].products[]`, not at the response's top level. */
function buildNestedArrayPathDrillDownActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: {
        categories: [{ products: [{ sku: "sku-a" }, { sku: "sku-b" }] }],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/pricing/",
      requestPostData: '{"sku":"sku-a"}',
      responseBody: { prices: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
    }),
  ];
}

/** A grouped/nested primary shape: an outer `sections[]` grouping array whose
 * single item holds a per-item `entries[]` array — the shape
 * `findAllObjectArrayFields` only surfaces once it recurses into each
 * group's own properties (see {@link detectDrillDownFoldPlan}'s nested
 * grouping array coverage in recon-generate-fold-plan.test.ts). The
 * drill-down URL threads the matched entry's `entryId`, so the structural
 * heuristic resolves this with no declared foldReturn spec. Shared by the
 * e2e test below so detection, schema inference, and codegen all fold the
 * SAME response against the SAME path, rather than each describing its own
 * independently-plausible fixture. */
function buildNestedGroupedDrillDownActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/sections",
      requestPostData: null,
      responseBody: {
        sections: [
          {
            label: "featured",
            entries: [
              { entryId: "e1", name: "Widget" },
              { entryId: "e2", name: "Gadget" },
            ],
          },
        ],
      },
      timestamp: "2024-05-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/entries/e2/details",
      requestPostData: null,
      responseBody: { details: [{ entryId: "e2", description: "A gadget." }] },
      timestamp: "2024-05-01T00:00:01Z",
    }),
  ];
}

const NESTED_ARRAY_PATH_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/pricing/",
  resultsPath: "categories.0.products",
  joinFields: ["sku"],
};

const COMPOSITE_SPEC: FoldReturnSpec = {
  endpointPattern: "/records/detail",
  resultsPath: "results",
  joinFields: ["accountId", "region"],
};

/** Mirrors recon-generate-multistep-return.test.ts's helper — the emitter takes
 * the unexported `ActionStep[]`, structurally identical to the shared fixture's
 * step except for the always-empty `produces`. */
function emit(steps: MulticallFixtureStep[], foldReturnSpec: FoldReturnSpec | null): string {
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
    new Map(),
    null,
    new Map(),
    new Map(),
    new Set(),
    [],
    new Map(),
    new Map(),
    foldReturnSpec
  );
}

/** A `results`/`sku`/`prices` foldReturn shape shared across several
 * fixtures below, both ones the structural heuristic can resolve on its own
 * and (via {@link buildUnthreadedJoinDrillDownActionSteps}) ones it can't. */
const SINGLE_SHOT_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/pricing/",
  resultsPath: "results",
  joinFields: ["sku"],
};

function flowFile(extra: Record<string, unknown>): string {
  return JSON.stringify({ steps: ["Search for a product"], ...extra });
}

describe("parseFoldReturnSpec", () => {
  it("parses a present, well-formed foldReturn block", () => {
    expect(parseFoldReturnSpec(flowFile({ foldReturn: SINGLE_SHOT_SPEC }))).toEqual(
      SINGLE_SHOT_SPEC
    );
  });

  it("returns null when foldReturn is absent", () => {
    expect(parseFoldReturnSpec(flowFile({}))).toBeNull();
  });

  it("returns null for an array-form flow (foldReturn has nowhere to live)", () => {
    expect(parseFoldReturnSpec(JSON.stringify(["Search for a product"]))).toBeNull();
  });

  it("returns null when foldReturn declares a non-string field", () => {
    expect(
      parseFoldReturnSpec(flowFile({ foldReturn: { ...SINGLE_SHOT_SPEC, joinFields: 42 } }))
    ).toBeNull();
  });

  it("returns null when joinFields is empty", () => {
    expect(
      parseFoldReturnSpec(flowFile({ foldReturn: { ...SINGLE_SHOT_SPEC, joinFields: [] } }))
    ).toBeNull();
  });

  it("returns null when joinFields contains a non-string element", () => {
    expect(
      parseFoldReturnSpec(
        flowFile({ foldReturn: { ...SINGLE_SHOT_SPEC, joinFields: ["sku", 42] } })
      )
    ).toBeNull();
  });

  it("parses a composite (multi-field) joinFields declaration", () => {
    const spec = { ...SINGLE_SHOT_SPEC, joinFields: ["accountId", "region"] };
    expect(parseFoldReturnSpec(flowFile({ foldReturn: spec }))).toEqual(spec);
  });

  it("returns null when foldReturn is missing a required field", () => {
    expect(
      parseFoldReturnSpec(
        flowFile({ foldReturn: { endpointPattern: "/catalog/pricing/", resultsPath: "results" } })
      )
    ).toBeNull();
  });

  it("includes drillResultsPath verbatim when declared", () => {
    const spec = { ...SINGLE_SHOT_SPEC, drillResultsPath: "detail.results.items" };
    expect(parseFoldReturnSpec(flowFile({ foldReturn: spec }))).toEqual(spec);
  });

  it("parses to a spec without drillResultsPath when omitted", () => {
    expect(parseFoldReturnSpec(flowFile({ foldReturn: SINGLE_SHOT_SPEC }))).not.toHaveProperty(
      "drillResultsPath"
    );
  });

  it("returns null when drillResultsPath is a non-string", () => {
    expect(
      parseFoldReturnSpec(flowFile({ foldReturn: { ...SINGLE_SHOT_SPEC, drillResultsPath: 42 } }))
    ).toBeNull();
  });

  it("returns null when drillResultsPath is an empty string", () => {
    expect(
      parseFoldReturnSpec(flowFile({ foldReturn: { ...SINGLE_SHOT_SPEC, drillResultsPath: "" } }))
    ).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseFoldReturnSpec("{not json")).toBeNull();
  });
});

describe("resolveFoldPlan", () => {
  it("falls back to a flow-declared foldReturn spec when the structural heuristic finds nothing", () => {
    const steps = buildUnthreadedJoinDrillDownActionSteps();

    // The join value never appears in the drill-down's captured request (the
    // stand-in for a header-threaded join), so detectDrillDownFoldPlan's
    // structural heuristic has no candidate array to disambiguate by —
    // without the declaration there is no plan.
    expect(resolveFoldPlan(steps)).toEqual([]);

    expect(resolveFoldPlan(steps, SINGLE_SHOT_SPEC)).toEqual([
      {
        primaryStepIndex: 0,
        primaryArrayPath: ["results"],
        targets: [
          {
            joinFields: ["sku"],
            drillStepIndex: 1,
            drillArrayPath: ["prices"],
            primaryMatchedItemIndex: 0,
            chain: [1],
            chainArrayPath: ["prices"],
            chainTerminalIndex: 1,
          },
        ],
      },
    ]);
  });

  it("honours the declared resultsPath even when the structural heuristic can't verify it", () => {
    const steps = buildUnthreadedJoinDrillDownActionSteps();

    // The structural heuristic has no threaded value to disambiguate by at
    // all here; the fold must key off the declared `results[]` regardless.
    const plan = resolveFoldPlan(steps, SINGLE_SHOT_SPEC);
    expect(plan[0]?.primaryArrayPath).toEqual(["results"]);
  });

  it("resolves the real results array over an earlier decoy without needing a declaration", () => {
    const steps = buildMulticallSingleShotSearchDrillDownActionSteps();

    // The primary response's decoy `facets[]` array is positioned earlier in
    // key order than `results[]`, but only `results[]`'s items thread the
    // `sku` join value into the drill-down's request, so the structural
    // heuristic alone resolves the real array — no foldReturn needed.
    expect(resolveFoldPlan(steps)).toEqual([
      {
        primaryStepIndex: 0,
        primaryArrayPath: ["results"],
        targets: [
          {
            joinFields: ["sku"],
            drillStepIndex: 1,
            drillArrayPath: ["prices"],
            primaryMatchedItemIndex: 0,
            chain: [1],
            chainArrayPath: ["prices"],
            chainTerminalIndex: 1,
          },
        ],
      },
    ]);
  });

  it("prefers the structural heuristic's plan over a foldReturn spec when both would resolve", () => {
    const steps = buildMulticallDependentDrillDownActionSteps();
    const heuristicOnly = resolveFoldPlan(steps);
    expect(heuristicOnly.length).toBeGreaterThan(0);

    // A spec pointing somewhere else entirely must not displace a plan the
    // captures themselves already prove — the declaration is a fallback, not
    // an override.
    expect(
      resolveFoldPlan(steps, {
        endpointPattern: "/nowhere/",
        resultsPath: "nothing",
        joinFields: ["nope"],
      })
    ).toEqual(heuristicOnly);
  });

  it("returns null when no spec is given and the heuristic finds nothing", () => {
    expect(resolveFoldPlan(buildMulticallHeterogeneousActionSteps())).toEqual([]);
  });

  it("merges a spec-declared drill-down target onto the heuristic's plan for the same primary", () => {
    const steps = buildPartiallyThreadedTwoDrillDownActionSteps();
    const heuristicOnly = resolveFoldPlan(steps);

    // The heuristic resolves only the body-threaded pricing drill-down on
    // its own — the header-threaded inventory drill-down is invisible to it.
    expect(heuristicOnly).toHaveLength(1);
    expect(heuristicOnly[0]?.targets).toHaveLength(1);
    expect(heuristicOnly[0]?.targets[0]?.drillStepIndex).toBe(1);

    const merged = resolveFoldPlan(steps, {
      endpointPattern: "/catalog/inventory/",
      resultsPath: "results",
      joinFields: ["sku"],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.primaryArrayPath).toEqual(["results"]);
    expect(merged[0]?.targets.map((target) => target.drillStepIndex).sort()).toEqual([1, 2]);
  });

  it("merges a spec-declared target onto the same primary the heuristic already resolved", () => {
    const steps = buildMulticallSingleShotSearchHeuristicAndSpecTwoTargetActionSteps();

    // The heuristic resolves the body-threaded pricing drill-down on its
    // own; the header-threaded stock drill-down is invisible to it.
    const heuristicOnly = resolveFoldPlan(steps);
    expect(heuristicOnly).toHaveLength(1);
    expect(heuristicOnly[0]?.targets).toEqual([
      {
        joinFields: ["sku"],
        drillStepIndex: 1,
        drillArrayPath: ["prices"],
        primaryMatchedItemIndex: 0,
        chain: [1],
        chainArrayPath: ["prices"],
        chainTerminalIndex: 1,
      },
    ]);

    const merged = resolveFoldPlan(steps, {
      endpointPattern: "/catalog/stock/",
      resultsPath: "results",
      joinFields: ["itemId"],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.primaryStepIndex).toBe(0);
    expect(merged[0]?.primaryArrayPath).toEqual(["results"]);
    expect(merged[0]?.targets).toEqual([
      {
        joinFields: ["sku"],
        drillStepIndex: 1,
        drillArrayPath: ["prices"],
        primaryMatchedItemIndex: 0,
        chain: [1],
        chainArrayPath: ["prices"],
        chainTerminalIndex: 1,
      },
      {
        joinFields: ["itemId"],
        drillStepIndex: 2,
        drillArrayPath: ["stock"],
        primaryMatchedItemIndex: 0,
        chain: [2],
        chainArrayPath: ["stock"],
        chainTerminalIndex: 2,
      },
    ]);
  });

  it("does not duplicate a target when the spec re-declares the same drillStepIndex the heuristic already found", () => {
    const steps = buildPartiallyThreadedTwoDrillDownActionSteps();

    const merged = resolveFoldPlan(steps, {
      endpointPattern: "/catalog/pricing/",
      resultsPath: "results",
      joinFields: ["sku"],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.targets).toHaveLength(1);
    expect(merged[0]?.targets[0]?.drillStepIndex).toBe(1);
  });

  it("returns null when the spec's endpointPattern matches no strictly-later action", () => {
    expect(
      resolveFoldPlan(buildUnthreadedJoinDrillDownActionSteps(), {
        ...SINGLE_SHOT_SPEC,
        endpointPattern: "/catalog/never-captured/",
      })
    ).toEqual([]);
  });

  it("returns null when the spec's endpointPattern is not a valid regex", () => {
    expect(
      resolveFoldPlan(buildUnthreadedJoinDrillDownActionSteps(), {
        ...SINGLE_SHOT_SPEC,
        endpointPattern: "([unclosed",
      })
    ).toEqual([]);
  });

  it("resolves a composite (multi-field) joinFields declaration to a plan carrying all fields", () => {
    const steps = buildCompositeJoinActionSteps();

    expect(resolveFoldPlan(steps, COMPOSITE_SPEC)).toEqual([
      {
        primaryStepIndex: 0,
        primaryArrayPath: ["results"],
        targets: [
          {
            joinFields: ["accountId", "region"],
            drillStepIndex: 1,
            drillArrayPath: ["details"],
            primaryMatchedItemIndex: 0,
            chain: [1],
            chainArrayPath: ["details"],
            chainTerminalIndex: 1,
          },
        ],
      },
    ]);
  });

  it("resolves the real per-item array over an earlier decoy on the drill side without needing a declaration", () => {
    const steps = buildDoubleDecoyDrillDownActionSteps();

    // The drill response's first object array by DFS is the decoy `errors[]`,
    // but only `details[]`'s items thread the `sku` join value into the
    // drill-down's own request, so the structural heuristic alone resolves
    // the real array on both sides — no foldReturn needed.
    expect(resolveFoldPlan(steps)).toEqual([
      {
        primaryStepIndex: 0,
        primaryArrayPath: ["results"],
        targets: [
          {
            joinFields: ["sku"],
            drillStepIndex: 1,
            drillArrayPath: ["details"],
            primaryMatchedItemIndex: 0,
            chain: [1],
            chainArrayPath: ["details"],
            chainTerminalIndex: 1,
          },
        ],
      },
    ]);
  });

  it("falls back to findObjectArrayField's DFS on the drill side when drillResultsPath is undeclared", () => {
    const steps = buildUnthreadedDoubleDecoyDrillDownActionSteps();
    const spec: FoldReturnSpec = {
      endpointPattern: "/catalog/pricing/",
      resultsPath: "results",
      joinFields: ["sku"],
    };

    // Preserves today's behavior for specs that don't declare
    // drillResultsPath: the DFS first match (the decoy `errors[]`) is used.
    expect(resolveFoldPlan(steps, spec)[0]?.targets[0]?.drillArrayPath).toEqual(["errors"]);
  });

  it("returns null when the declared drillResultsPath resolves to no non-empty object array", () => {
    const steps = buildUnthreadedDoubleDecoyDrillDownActionSteps();
    const spec: FoldReturnSpec = {
      endpointPattern: "/catalog/pricing/",
      resultsPath: "results",
      drillResultsPath: "nothing",
      joinFields: ["sku"],
    };

    expect(resolveFoldPlan(steps, spec)).toEqual([]);
  });

  it("resolves primaryMatchedItemIndex against the drill request's headers, not just URL/body", () => {
    const steps = buildHeaderThreadedNonFirstItemDrillDownActionSteps();

    // The join value lives only in an `X-Item-Sku` header naming the SECOND
    // primary item, so a spec-resolved plan must resolve
    // primaryMatchedItemIndex to 1, not guess 0.
    expect(resolveFoldPlan(steps, SINGLE_SHOT_SPEC)).toEqual([
      {
        primaryStepIndex: 0,
        primaryArrayPath: ["results"],
        targets: [
          {
            joinFields: ["sku"],
            drillStepIndex: 1,
            drillArrayPath: ["prices"],
            primaryMatchedItemIndex: 1,
            chain: [1],
            chainArrayPath: ["prices"],
            chainTerminalIndex: 1,
          },
        ],
      },
    ]);
  });

  it("returns null (fails closed) when no primary item's joinFields values match the drill request", () => {
    const steps = buildHeaderThreadedNoMatchDrillDownActionSteps();

    // The header carries a sku that matches neither primary item, so the
    // plan must not resolve at all rather than guessing index 0.
    expect(resolveFoldPlan(steps, SINGLE_SHOT_SPEC)).toEqual([]);
  });

  it("returns null when the resolved drill-down step is multipart", () => {
    const steps = buildMulticallSingleShotSearchDrillDownActionSteps();
    const multipartDrill = steps.map((step, i) =>
      i === 1 ? { ...step, isMultipart: true } : step
    );

    // The fold loop re-issues the drill call per item by re-keying its
    // rendered JSON request template; a raw FormData upload has no such
    // template, so the plan must be dropped rather than emitted broken.
    expect(resolveFoldPlan(multipartDrill, SINGLE_SHOT_SPEC)).toEqual([]);
  });
});

describe("selectEffectiveResponseBody — flow-declared foldReturn", () => {
  it("samples the declared array folded with the drill-down's fields, not either bare body", () => {
    const steps = buildMulticallSingleShotSearchDrillDownActionSteps();

    expect(selectEffectiveResponseBody(true, steps, null, SINGLE_SHOT_SPEC)).toEqual({
      facets: [{ name: "brand" }],
      results: [{ sku: "sku-a", amount: 19.99 }, { sku: "sku-b" }],
    });
  });

  it("resolves the real results array over an earlier decoy without needing a declaration", () => {
    const steps = buildMulticallSingleShotSearchDrillDownActionSteps();

    // The primary response's decoy `facets[]` array is positioned earlier in
    // key order than `results[]`, but the structural heuristic now resolves
    // the real array on its own, so the fold happens even with no spec at
    // all — the declaration above is a fallback, not the only path to it.
    expect(selectEffectiveResponseBody(true, steps, null)).toEqual({
      facets: [{ name: "brand" }],
      results: [{ sku: "sku-a", amount: 19.99 }, { sku: "sku-b" }],
    });
  });

  it("leaves the sample unfolded when the structural heuristic has nothing to thread", () => {
    const steps = buildUnthreadedJoinDrillDownActionSteps();

    // The join value never appears in the drill-down's captured request (the
    // stand-in for a header-threaded join), so neither the heuristic nor a
    // declaration is available here — shape inference must fall back to
    // selectReturnAction's plain pick.
    expect(selectEffectiveResponseBody(true, steps, null)).toEqual({
      prices: [{ sku: "sku-a", amount: 19.99 }],
    });
  });

  it("folds onto the item the spec-resolved plan actually matched, not primary items[0]", () => {
    const steps = buildHeaderThreadedNonFirstItemDrillDownActionSteps();

    // The header threads the SECOND primary item's sku ("sku-b"), so
    // primaryMatchedItemIndex resolves to 1 — the fold must land the
    // drill-down's amount onto items[1], leaving items[0] untouched, not
    // hard-code items[0] as the merge target.
    expect(selectEffectiveResponseBody(true, steps, null, SINGLE_SHOT_SPEC)).toEqual({
      results: [{ sku: "sku-a" }, { sku: "sku-b", amount: 24.99 }],
    });
  });

  it("folds the drill item whose own sku matches the join key, not the drill array's index 0", () => {
    const steps = buildMulticallSingleShotSearchDrillDownMultiMatchActionSteps();

    // The drill-down's prices[] holds a decoy ("sku-z") at index 0 and the
    // real match ("sku-a") at index 1 — a fold that took drillItems?.[0]
    // would splice the decoy's amount (5.0) onto the primary item instead.
    expect(selectEffectiveResponseBody(true, steps, null, SINGLE_SHOT_SPEC)).toEqual({
      results: [{ sku: "sku-a", amount: 19.99 }],
    });
  });

  it("folds the drill item whose join value matches by VALUE across mismatched JS types, not index 0", () => {
    const steps = buildMulticallSingleShotSearchDrillDownTypeMismatchJoinActionSteps();

    // The primary side's accountId is a number (42); every candidate on the
    // drill side has accountId as a string, and the decoy ("99") sorts
    // before the real match ("42", transactionId "t-real"). A strict `===`
    // comparison would never match the number against either string and
    // would fall through to drillItems?.[0] — the decoy — instead of
    // resolving the real match by coerced value equality.
    expect(selectEffectiveResponseBody(true, steps, null)).toEqual({
      accounts: [{ accountId: "42", name: "Acme", transactionId: "t-real" }],
    });
  });

  it("rebuilds through an array-typed path segment instead of returning the body unfolded", () => {
    const steps = buildNestedArrayPathDrillDownActionSteps();

    // resultsPath ("categories.0.products") walks through the array at
    // "categories" via its "0" segment before reaching "products" —
    // objectItemsAtPath must descend into that array node to locate the
    // matched item, not bail out and return the primary body byte-identical
    // to its unfolded original.
    expect(selectEffectiveResponseBody(true, steps, null, NESTED_ARRAY_PATH_SPEC)).toEqual({
      categories: [{ products: [{ sku: "sku-a", amount: 19.99 }, { sku: "sku-b" }] }],
    });
  });
});

describe("emitMultiStepExecuteHttp — flow-declared foldReturn", () => {
  it("emits the per-item loop-and-merge for a spec-resolved plan the heuristic cannot see", () => {
    const body = emit(buildMulticallSingleShotSearchDrillDownActionSteps(), SINGLE_SHOT_SPEC);

    // The loop iterates the DECLARED results[] array, re-issues the pricing
    // call per item, and merges each response back onto its item — so the
    // return references the folded primary, not the drill-down's own body.
    expect(body).toContain("const foldItems = (r0 as { results: Record<string, unknown>[] })");
    expect(body).toContain("for (const item of foldItems) {");
    expect(body).toContain("const foldMatch = foldMatches.find(");
    expect(body).toContain("Object.assign(item, foldMatch ?? {});");
    expect(body).toContain("return { data: r0 };");
    expect(body).not.toContain("return { data: r1 };");

    // The declared array wins over findObjectArrayField's DFS first match.
    expect(body).not.toContain("as { facets: Record<string, unknown>[] }");

    // The join must be re-keyed to the loop item, or every iteration would
    // re-issue the captured item's call and fold one response onto all items.
    expect(body).toContain(`body: \`{"sku":"\${item.sku}"}\``);
    expect(body).not.toContain('"sku":"sku-a"');
  });

  it("emits a join-key .find(...) match for the fold, not a bare drill-array index", () => {
    const body = emit(
      buildMulticallSingleShotSearchDrillDownMultiMatchActionSteps(),
      SINGLE_SHOT_SPEC
    );

    // The drill-down's own prices[] holds a decoy ahead of the real match at
    // runtime; the emitted loop must select by the join field's value, not
    // by lifting foldMatches[0] straight off the response.
    expect(body).toContain(`foldMatches.find((m) => String(m["sku"]) === String(item.sku))`);
    expect(body).not.toContain("Object.assign(item, foldMatches[0] ?? {});");
    expect(body).toContain("Object.assign(item, foldMatch ?? {});");
  });

  it("emits a type-coerced join-key .find(...) match, not a bare === that could never match", () => {
    const body = emit(buildMulticallSingleShotSearchDrillDownTypeMismatchJoinActionSteps(), null);

    // The primary side's accountId is a number and the drill side's is a
    // string on every candidate — a bare `m["accountId"] === item.accountId`
    // could never match either candidate and would silently fall through to
    // foldMatches[0], the decoy. The emitted predicate must coerce both
    // sides to string before comparing.
    expect(body).toContain(
      `foldMatches.find((m) => String(m["accountId"]) === String(item.accountId))`
    );
    expect(body).not.toContain("Object.assign(item, foldMatches[0] ?? {});");
    expect(body).toContain("Object.assign(item, foldMatch ?? {});");
  });

  it("parameterizes every field of a composite joinFields declaration, not just the first", () => {
    const body = emit(buildCompositeJoinActionSteps(), COMPOSITE_SPEC);

    expect(body).toContain("const foldItems = (r0 as { results: Record<string, unknown>[] })");
    expect(body).toContain("for (const item of foldItems) {");
    expect(body).toContain("const foldMatch = foldMatches.find(");
    expect(body).toContain("Object.assign(item, foldMatch ?? {});");

    // Both join fields must re-key to the loop item, not just accountId.
    expect(body).toContain(
      `body: \`{"accountId":"\${item.accountId}","region":"\${item.region}"}\``
    );
    expect(body).not.toContain('"accountId":"acc-1"');
    expect(body).not.toContain('"region":"us"');

    // The fold match itself must key on BOTH join fields, not just the first.
    expect(body).toContain(
      `foldMatches.find((m) => String(m["accountId"]) === String(item.accountId) && String(m["region"]) === String(item.region))`
    );
  });

  it("emits the per-item loop-and-merge for the decoy fixture without needing a declaration", () => {
    const body = emit(buildMulticallSingleShotSearchDrillDownActionSteps(), null);

    // Same structural heuristic that resolves resolveFoldPlan and
    // selectEffectiveResponseBody without a spec also drives emission — the
    // decoy `facets[]` array must not win over `results[]` here either.
    expect(body).toContain("const foldItems = (r0 as { results: Record<string, unknown>[] })");
    expect(body).toContain("for (const item of foldItems) {");
    expect(body).toContain("const foldMatch = foldMatches.find(");
    expect(body).toContain("Object.assign(item, foldMatch ?? {});");
    expect(body).toContain("return { data: r0 };");
    expect(body).not.toContain("return { data: r1 };");
    expect(body).not.toContain("as { facets: Record<string, unknown>[] }");
  });

  it("emits no fold loop for steps the structural heuristic can't thread a join value across", () => {
    const body = emit(buildUnthreadedJoinDrillDownActionSteps(), null);

    expect(body).not.toContain("const foldItems");
    expect(body).toContain("return { data: r1 };");
  });

  it("emits a per-item loop over the real arrays on both sides for a double decoy with no spec declared", () => {
    const body = emit(buildDoubleDecoyDrillDownActionSteps(), null);

    // Neither side's decoy (`facets[]` on the primary, `errors[]` on the
    // drill) should win: the structural heuristic threads the `sku` join
    // value through the real `results[]`/`details[]` arrays on its own.
    expect(body).toContain("const foldItems = (r0 as { results: Record<string, unknown>[] })");
    expect(body).toContain("for (const item of foldItems) {");
    expect(body).toContain(
      "const foldMatches = (r1 as { details: Record<string, unknown>[] }).details;"
    );
    expect(body).toContain("const foldMatch = foldMatches.find(");
    expect(body).toContain("Object.assign(item, foldMatch ?? {});");
    expect(body).not.toContain("as { facets: Record<string, unknown>[] }");
    expect(body).not.toContain("as { errors: Record<string, unknown>[] }");
  });

  it("parameterizes against the primary item the drill request actually matched, not items[0]", () => {
    // The drill-down's own URL threads sku-b (results[1]) as a query
    // param, not sku-a (results[0]). Unlike a top-level JSON body key
    // (payload-ified generically before this fold branch ever runs, see
    // applyPayloadKeyValueSubstitutions), a URL query param reaches
    // `parameterize` as the RAW captured literal — so a fold branch that
    // always read primaryItems[0] would look for sku-a's literal, find no
    // match in the rendered URL, and silently no-op, re-issuing the exact
    // sku-b call captured here on every loop iteration instead of
    // substituting each item's own sku.
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/catalog/search/",
        requestPostData: '{"page":1}',
        responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
        timestamp: "2024-04-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/catalog/pricing/?sku=sku-b",
        requestPostData: '{"lookup":true}',
        responseBody: { prices: [{ sku: "sku-b", amount: 24.99 }] },
        timestamp: "2024-04-01T00:00:01Z",
      }),
    ];
    const body = emit(steps, SINGLE_SHOT_SPEC);

    expect(body).toContain("const foldItems = (r0 as { results: Record<string, unknown>[] })");
    expect(body).toContain("for (const item of foldItems) {");
    expect(body).toContain(`/catalog/pricing/?sku=\${item.sku}`);
    expect(body).not.toContain("sku=sku-a");
    expect(body).not.toContain("sku=sku-b");
  });

  it("emits foldMatches off the declared drillResultsPath, not the drill side's DFS-first decoy", () => {
    const spec: FoldReturnSpec = {
      endpointPattern: "/catalog/pricing/",
      resultsPath: "results",
      drillResultsPath: "details",
      joinFields: ["sku"],
    };
    const body = emit(buildDoubleDecoyDrillDownActionSteps(), spec);

    // The loop iterates the declared primary results[] and folds the drill
    // response's DECLARED details[] array onto each item, re-issuing the
    // pricing call per item.
    expect(body).toContain("const foldItems = (r0 as { results: Record<string, unknown>[] })");
    expect(body).toContain("for (const item of foldItems) {");
    expect(body).toContain(
      "const foldMatches = (r1 as { details: Record<string, unknown>[] }).details;"
    );
    expect(body).toContain("const foldMatch = foldMatches.find(");
    expect(body).toContain("Object.assign(item, foldMatch ?? {});");

    // The declared drillResultsPath wins over findObjectArrayField's DFS
    // first match on the drill side, which would have picked the decoy
    // errors[] array instead.
    expect(body).not.toContain("as { errors: Record<string, unknown>[] }");
  });
});

describe("grouped/nested primary fold — detection, schema inference, and codegen agree", () => {
  it("fold detection, schema-inference folding, and the emitted loop all describe the same nested-array fold", () => {
    const steps = buildNestedGroupedDrillDownActionSteps();

    // 1. detectDrillDownFoldPlan's structural heuristic must resolve a plan
    // naming the NESTED array path — not just the outer grouping array — or
    // there is nothing for the other two surfaces to agree on.
    const plan =
      detectDrillDownFoldPlan(
        steps as unknown as Parameters<typeof detectDrillDownFoldPlan>[0]
      )[0] ?? null;
    expect(plan).not.toBeNull();
    expect(plan?.primaryArrayPath).toEqual(["sections", "*", "entries"]);
    expect(plan?.targets[0]?.joinFields).toEqual(["entryId"]);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["details"]);
    expect(plan?.targets[0]?.primaryMatchedItemIndex).toBe(1);

    // 2. selectEffectiveResponseBody must fold the drill-down's field in at
    // that SAME nested path — replaceByReference rebuilding through the
    // outer sections[] array, not silently no-opping and leaving the body
    // unfolded.
    expect(selectEffectiveResponseBody(true, steps, null)).toEqual({
      sections: [
        {
          label: "featured",
          entries: [
            { entryId: "e1", name: "Widget" },
            { entryId: "e2", name: "Gadget", description: "A gadget." },
          ],
        },
      ],
    });

    // 3. emitMultiStepExecuteHttp's emitted loop must read foldItems off the
    // identical path literal the plan named in (1) — not some other
    // plausible-looking path the emitter derived independently. The "*"
    // segment compiles to a `.flatMap` over every section, not a literal
    // ["0"] index into the one group this single-group fixture happens to
    // have — see ARRAY_WILDCARD_SEGMENT in recon-generate.ts.
    const body = emit(steps, null);
    expect(body).toContain(
      "const foldItems = (r0 as { sections: ({ entries: Record<string, unknown>[] })[] }).sections.flatMap((g0) => g0.entries);"
    );
    expect(body).toContain("for (const item of foldItems) {");
    expect(body).toContain(
      "const foldMatches = (r1 as { details: Record<string, unknown>[] }).details;"
    );
    expect(body).toContain("const foldMatch = foldMatches.find(");
    expect(body).toContain("Object.assign(item, foldMatch ?? {});");
    expect(body).toContain("return { data: r0 };");
  });

  it("folds correctly when the matched item lives in a non-first outer group, not just group 0", () => {
    const steps = buildMulticallNestedGroupedDrillDownMultiGroupActionSteps();

    // 1. Detection must resolve the item that actually matched — group 1's
    // e2 — regardless of which group it lives in.
    const plan =
      detectDrillDownFoldPlan(
        steps as unknown as Parameters<typeof detectDrillDownFoldPlan>[0]
      )[0] ?? null;
    expect(plan).not.toBeNull();
    expect(plan?.primaryArrayPath).toEqual(["sections", "*", "entries"]);
    expect(plan?.targets[0]?.joinFields).toEqual(["entryId"]);

    // 2. The emitted accessor flattens every group instead of indexing into
    // whichever one the matched item happened to be captured in.
    const body = emit(steps, null);
    expect(body).toContain(
      "const foldItems = (r0 as { sections: ({ entries: Record<string, unknown>[] })[] }).sections.flatMap((g0) => g0.entries);"
    );
    expect(body).not.toContain('sections["0"]');
    expect(body).not.toContain("sections[0]");

    // 3. Shape inference must fold the drilled description onto the SECOND
    // group's entry (e2), leaving every other item — in EITHER group —
    // untouched, proving the fold isn't scoped to group 0.
    expect(selectEffectiveResponseBody(true, steps, null)).toEqual({
      sections: [
        {
          label: "featured",
          entries: [
            { entryId: "e1", name: "Widget" },
            { entryId: "e3", name: "Doohickey" },
          ],
        },
        {
          label: "clearance",
          entries: [
            { entryId: "e2", name: "Gadget", description: "A gadget." },
            { entryId: "e4", name: "Thingamajig" },
          ],
        },
      ],
    });
  });
});
