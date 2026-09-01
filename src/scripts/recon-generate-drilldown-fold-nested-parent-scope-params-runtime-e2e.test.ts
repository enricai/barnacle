import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import {
  buildMulticallNestedGroupedDrillDownAncestorOnlyParamsActionSteps,
  buildMulticallNestedGroupedDrillDownTwoScopeParamsActionSteps,
} from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression coverage for a nested fold whose drill request needs one param
 * that only lives on the PARENT group (`groupId`, reachable solely via the
 * ancestor loop binding once the fold descends into `entries`) and one that
 * only lives on the ITEM itself (`itemDate`). `.flatMap`ing the parent away
 * (the pre-fix behavior) discards the ancestor binding entirely, so neither
 * param has anywhere real to come from and both freeze as the first
 * capture's literal — silently reusing group 1's query string for every
 * item in every group.
 */

const TWO_SCOPE_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/entries/details",
  resultsPath: "sections.*.entries",
  drillResultsPath: "details",
  joinFields: ["entryId"],
};

function emitBody(): string {
  const actionSteps = buildMulticallNestedGroupedDrillDownTwoScopeParamsActionSteps();
  return emitMultiStepExecuteHttp(
    actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
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
    TWO_SCOPE_SPEC
  );
}

/** Stubs `fetch` to answer the fixture's calls, in call order, with each
 * call's own real-shaped response body. */
function stubSequentialFetch(bodies: unknown[]): void {
  const fn = vi.fn();
  for (const body of bodies) {
    fn.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify(body)),
      headers: new Headers(),
    });
  }
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate drill-down fold — nested fold threads BOTH a parent-scope and an item-scope drill param", () => {
  it("emits nested loops (not .flatMap) and interpolates the parent-only and item-only params, never as literals", () => {
    const body = emitBody();

    // #1: the parent binding stays addressable via a nested loop, not a
    // flattening `.flatMap`.
    expect(body).not.toContain(".flatMap(");
    expect(body).toContain("for (const g0 of");
    expect(body).toContain("for (const item of g0.entries)");

    // #2: both the parent-only (`groupId`) and item-only (`itemDate`)
    // params interpolate off their own real binding.
    expect(body).toContain(`$${"{g0.id}"}`);
    expect(body).toContain(`$${"{item.date}"}`);
    expect(body).toContain(`$${"{item.entryId}"}`);

    // #3: the two captured groups/dates this fixture proves vary
    // (sec1/2024-01-01 and sec2/2024-02-01) never survive as frozen
    // literals in the drill request template.
    expect(body).not.toContain("groupId=sec1");
    expect(body).not.toContain("groupId=sec2");
    expect(body).not.toContain("itemDate=2024-01-01");
    expect(body).not.toContain("itemDate=2024-02-01");
  });

  it("at runtime, threads each item's own groupId+itemDate into its own drill request and folds its own matching response", async () => {
    const body = emitBody();
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    // Call order: r0 (primary), then one drill per (group, entry) pair in
    // loop order (sec1/e1, sec2/e2), then the fixture's own trailing decoy
    // call (unrelated values, never matched onto any fold target) — every
    // real generated plugin re-issues every captured action, matched fold
    // targets or not.
    stubSequentialFetch([
      {
        sections: [
          { id: "sec1", entries: [{ entryId: "e1", name: "Widget", date: "2024-01-01" }] },
          { id: "sec2", entries: [{ entryId: "e2", name: "Gadget", date: "2024-02-01" }] },
        ],
      },
      { details: [{ entryId: "e1", description: "Widget detail for sec1." }] },
      { details: [{ entryId: "e2", description: "Gadget detail for sec2." }] },
      { details: [] },
    ]);

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com" });

    expect(result.data).toEqual({
      sections: [
        {
          id: "sec1",
          entries: [
            {
              entryId: "e1",
              name: "Widget",
              date: "2024-01-01",
              description: "Widget detail for sec1.",
            },
          ],
        },
        {
          id: "sec2",
          entries: [
            {
              entryId: "e2",
              name: "Gadget",
              date: "2024-02-01",
              description: "Gadget detail for sec2.",
            },
          ],
        },
      ],
    });

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(4);
    // Each item's own drill request carries its OWN groupId + itemDate —
    // not group 1's, frozen and reused for every item.
    expect(String(calls[1]![0])).toContain("entryId=e1");
    expect(String(calls[1]![0])).toContain("groupId=sec1");
    expect(String(calls[1]![0])).toContain("itemDate=2024-01-01");
    expect(String(calls[2]![0])).toContain("entryId=e2");
    expect(String(calls[2]![0])).toContain("groupId=sec2");
    expect(String(calls[2]![0])).toContain("itemDate=2024-02-01");
  });
});

const ANCESTOR_ONLY_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/entries/details",
  resultsPath: "sections.*.entries",
  drillResultsPath: "details",
  joinFields: ["entryId"],
};

function emitAncestorOnlyBody(): string {
  const actionSteps = buildMulticallNestedGroupedDrillDownAncestorOnlyParamsActionSteps();
  return emitMultiStepExecuteHttp(
    actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
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
    ANCESTOR_ONLY_SPEC
  );
}

/**
 * Regression coverage for a nested fold whose drill request only needs the
 * PARENT group's own `id` — never any field on the nested item. The
 * hoisting fix must splice this fetch above the item loop and reuse it for
 * every item in the group, instead of re-issuing it once per item.
 */
describe("recon-generate drill-down fold — nested fold threads ONLY an ancestor-scope drill param", () => {
  it("at runtime, calls the drill endpoint exactly once per group (not once per item) and joins every item its own fields", async () => {
    const body = emitAncestorOnlyBody();
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    // Call order: r0 (primary), then one drill per GROUP (sec1, sec2) — not
    // one per item, even though each group holds 3 items — then the
    // fixture's own trailing decoy call.
    stubSequentialFetch([
      {
        sections: [
          {
            id: "sec1",
            entries: [
              { entryId: "e1", name: "Widget" },
              { entryId: "e2", name: "Gadget" },
              { entryId: "e3", name: "Doohickey" },
            ],
          },
          {
            id: "sec2",
            entries: [
              { entryId: "e4", name: "Thingamajig" },
              { entryId: "e5", name: "Contraption" },
              { entryId: "e6", name: "Gizmo" },
            ],
          },
        ],
      },
      {
        details: [
          { entryId: "e1", description: "A widget." },
          { entryId: "e2", description: "A gadget." },
          { entryId: "e3", description: "A doohickey." },
        ],
      },
      {
        details: [
          { entryId: "e4", description: "A thingamajig." },
          { entryId: "e5", description: "A contraption." },
          { entryId: "e6", description: "A gizmo." },
        ],
      },
      // The fixture's own trailing decoy call (unrelated `groupId`, never
      // matched onto any fold target) — every real generated plugin
      // re-issues every captured action, matched fold targets or not.
      { details: [] },
    ]);

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com" });

    expect(result.data).toEqual({
      sections: [
        {
          id: "sec1",
          entries: [
            { entryId: "e1", name: "Widget", description: "A widget." },
            { entryId: "e2", name: "Gadget", description: "A gadget." },
            { entryId: "e3", name: "Doohickey", description: "A doohickey." },
          ],
        },
        {
          id: "sec2",
          entries: [
            { entryId: "e4", name: "Thingamajig", description: "A thingamajig." },
            { entryId: "e5", name: "Contraption", description: "A contraption." },
            { entryId: "e6", name: "Gizmo", description: "A gizmo." },
          ],
        },
      ],
    });

    // #1: exactly 4 fetches total — the primary, ONE drill per group (not
    // one per item, which would make 6 in a 2-group/3-item-each fixture),
    // and the fixture's own trailing decoy call.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(4);
    expect(String(calls[1]![0])).toContain("groupId=sec1");
    expect(String(calls[2]![0])).toContain("groupId=sec2");
    expect(String(calls[3]![0])).toContain("groupId=zzz-unrelated-g");
  });
});
