import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallNestedGroupedDrillDownScopeCoincidentParamActionSteps } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression coverage for the scope-coincidence bug: when a threaded drill
 * param's literal value happens to equal BOTH the ancestor's own field and
 * the matched (first) item's own field, the fold plan must still hoist the
 * drill to the ancestor binding, not the item — because only the ancestor
 * binding is well-defined for every sibling item, including ones whose own
 * field diverges from the group's value.
 */

const SCOPE_COINCIDENT_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/entries/details",
  resultsPath: "sections.*.entries",
  drillResultsPath: "details",
  joinFields: ["entryId"],
};

function emitBody(): string {
  const actionSteps = buildMulticallNestedGroupedDrillDownScopeCoincidentParamActionSteps();
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
    SCOPE_COINCIDENT_SPEC
  );
}

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

describe("recon-generate drill-down fold — scope-coincident drill param still hoists to the ancestor binding", () => {
  it("structurally emits the drill fetch call site before the item-loop open, bound to the ancestor field only", () => {
    const body = emitBody();

    const groupLoopIndex = body.indexOf("for (const g0 of");
    const drillFetchCallIndex = body.indexOf("catalog/entries/details?code=");
    const itemLoopIndex = body.indexOf("for (const item of");

    expect(groupLoopIndex).toBeGreaterThanOrEqual(0);
    expect(drillFetchCallIndex).toBeGreaterThanOrEqual(0);
    expect(itemLoopIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeLessThan(itemLoopIndex);
    expect(body).toContain("catalog/entries/details?code=${g0.masterCode}");
    expect(body).not.toContain("catalog/entries/details?code=${item");
  });

  it("at runtime, calls the drill endpoint exactly once per group (not once per item) and correctly joins every item, including siblings whose own field diverges from the group's", async () => {
    const body = emitBody();
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    // Each group's matched (first) item's own `code` coincidentally equals
    // the group's `masterCode` — e1's `code` is `sec1`, e4's `code` is
    // `sec2` — but the sibling items in each group (e2/e3, e5/e6) carry a
    // DISTINCT own `code`. If the fold plan wrongly bound the drill to the
    // item instead of the ancestor, it would only be able to resolve a URL
    // for the matched item, and would fetch it once per item rather than
    // once per group.
    stubSequentialFetch([
      {
        sections: [
          {
            masterCode: "sec1",
            entries: [
              { entryId: "e1", code: "sec1", name: "Widget" },
              { entryId: "e2", code: "e2-code", name: "Gadget" },
              { entryId: "e3", code: "e3-code", name: "Doohickey" },
            ],
          },
          {
            masterCode: "sec2",
            entries: [
              { entryId: "e4", code: "sec2", name: "Thingamajig" },
              { entryId: "e5", code: "e5-code", name: "Contraption" },
              { entryId: "e6", code: "e6-code", name: "Gizmo" },
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
      // The fixture's own trailing decoy call (unrelated `code`, never
      // matched onto any fold target).
      { details: [] },
    ]);

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com" });

    expect(result.data).toEqual({
      sections: [
        {
          masterCode: "sec1",
          entries: [
            { entryId: "e1", code: "sec1", name: "Widget", description: "A widget." },
            { entryId: "e2", code: "e2-code", name: "Gadget", description: "A gadget." },
            { entryId: "e3", code: "e3-code", name: "Doohickey", description: "A doohickey." },
          ],
        },
        {
          masterCode: "sec2",
          entries: [
            { entryId: "e4", code: "sec2", name: "Thingamajig", description: "A thingamajig." },
            { entryId: "e5", code: "e5-code", name: "Contraption", description: "A contraption." },
            { entryId: "e6", code: "e6-code", name: "Gizmo", description: "A gizmo." },
          ],
        },
      ],
    });

    // Exactly 4 fetches total — the primary, ONE drill per group (not one
    // per item, which would make 6 in a 2-group/3-item-each fixture, and
    // not one per matching item alone, which would make 2), and the
    // fixture's own trailing decoy call.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(4);
    expect(String(calls[1]![0])).toContain("code=sec1");
    expect(String(calls[2]![0])).toContain("code=sec2");
    expect(String(calls[3]![0])).toContain("code=zzz-unrelated");
  });
});
