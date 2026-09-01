import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallNestedGroupedDrillDownAncestorOnlyParamsActionSteps } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Requirement (A) regression coverage: when every threaded drill param
 * resolves to an ancestor (group) binding and none reference the nested
 * item, the emitted fetch for the drill request must be hoisted above the
 * item loop and issued once per group, while every item in the group still
 * receives its own joined/merged drill fields.
 */

const ANCESTOR_ONLY_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/entries/details",
  resultsPath: "sections.*.entries",
  drillResultsPath: "details",
  joinFields: ["entryId"],
};

function emitBody(): string {
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

describe("recon-generate drill-down fold — all-ancestor-scoped drill param is hoisted above the item loop", () => {
  it("structurally emits the drill fetch/await call site before the item-loop open", () => {
    const body = emitBody();

    const groupLoopIndex = body.indexOf("for (const g0 of");
    const drillFetchCallIndex = body.indexOf("catalog/entries/details?groupId=");
    const itemLoopIndex = body.indexOf("for (const item of");

    expect(groupLoopIndex).toBeGreaterThanOrEqual(0);
    expect(drillFetchCallIndex).toBeGreaterThanOrEqual(0);
    expect(itemLoopIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeLessThan(itemLoopIndex);
  });

  it("at runtime, calls the drill endpoint exactly once per group (not once per item) and joins every item its own fields", async () => {
    const body = emitBody();
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

    // Exactly 4 fetches total — the primary, ONE drill per group (not one
    // per item, which would make 6 in a 2-group/3-item-each fixture), and
    // the fixture's own trailing decoy call.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(4);
    expect(String(calls[1]![0])).toContain("groupId=sec1");
    expect(String(calls[2]![0])).toContain("groupId=sec2");
    expect(String(calls[3]![0])).toContain("groupId=zzz-unrelated-g");
  });
});
