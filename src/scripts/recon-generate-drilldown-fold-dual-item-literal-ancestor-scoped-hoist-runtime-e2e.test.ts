import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallNestedGroupedDrillDownDualItemLiteralDistinctSubpathAncestorScopedParamsActionSteps } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression coverage for the dual-param item-literal hoist bug: when TWO
 * threaded drill params each equal ONLY the matched (first) item's own
 * field — never the ancestor's own field, and each resolvable under a
 * DIFFERENT nested ancestor sub-path — the fold plan must still hoist the
 * drill to the ancestor binding for BOTH params, not just one, because a
 * plan that hoists only one param would still issue a fetch per item for
 * the other, unresolved one.
 */

const DUAL_DISTINCT_SUBPATH_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/entries/details",
  resultsPath: "sections.*.entries",
  drillResultsPath: "details",
  joinFields: ["entryId"],
};

function emitBody(): string {
  const actionSteps =
    buildMulticallNestedGroupedDrillDownDualItemLiteralDistinctSubpathAncestorScopedParamsActionSteps();
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
    DUAL_DISTINCT_SUBPATH_SPEC
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

describe("recon-generate drill-down fold — dual item-literal drill params both hoist to the ancestor binding", () => {
  it("structurally emits the drill fetch call site before the item-loop open, bound to the ancestor group only for BOTH params", () => {
    const body = emitBody();

    const groupLoopIndex = body.indexOf("for (const g0 of");
    const drillFetchCallIndex = body.indexOf("catalog/entries/details?code=");
    const itemLoopIndex = body.indexOf("for (const item of");

    expect(groupLoopIndex).toBeGreaterThanOrEqual(0);
    expect(drillFetchCallIndex).toBeGreaterThanOrEqual(0);
    expect(itemLoopIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeLessThan(itemLoopIndex);
    // Stronger than the single-param regression test: no reference to the
    // item-loop binding anywhere in the emitted body at all, ruling out a
    // partial hoist where one of the two params stays item-bound.
    expect(body).not.toContain("${item");
  });

  it("at runtime, calls the drill endpoint exactly once per group (not once per item) and correctly joins every item, including siblings whose own fields diverge from the matched item's literals", async () => {
    const body = emitBody();
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    // Each group's drill literals (`pv1`/`cv1` and `pv2`/`cv2`) equal ONLY
    // the matched (first) item's own `ownCode`/`ownDetailCode` — never the
    // group's own `primaryVariant.code` / `cheapestVariant.detail.code`
    // read in isolation from the OTHER param's ancestor sub-path. The
    // sibling items in each group carry DISTINCT own fields. If the fold
    // plan wrongly bound either drill param to the item instead of the
    // ancestor's captured request, it could only resolve a URL for the
    // matched item, and would fetch once per item rather than once per
    // group.
    stubSequentialFetch([
      {
        sections: [
          {
            masterCode: "grp1",
            primaryVariant: { code: "pv1" },
            cheapestVariant: { detail: { code: "cv1" } },
            entries: [
              { entryId: "e1", ownCode: "pv1", ownDetailCode: "cv1", name: "Widget" },
              { entryId: "e2", ownCode: "pv1-alt", ownDetailCode: "cv1-alt", name: "Gadget" },
              { entryId: "e3", ownCode: "pv1-alt2", ownDetailCode: "cv1-alt3", name: "Doohickey" },
            ],
          },
          {
            masterCode: "grp2",
            primaryVariant: { code: "pv2" },
            cheapestVariant: { detail: { code: "cv2" } },
            entries: [
              { entryId: "e4", ownCode: "pv2", ownDetailCode: "cv2", name: "Thingamajig" },
              { entryId: "e5", ownCode: "pv2-alt", ownDetailCode: "cv2-alt", name: "Contraption" },
              { entryId: "e6", ownCode: "pv2-alt2", ownDetailCode: "cv2-alt3", name: "Gizmo" },
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
      // The fixture's own trailing decoy call (unrelated `code`/`detail`,
      // never matched onto any fold target).
      { details: [] },
    ]);

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com" });

    expect(result.data).toEqual({
      sections: [
        {
          masterCode: "grp1",
          primaryVariant: { code: "pv1" },
          cheapestVariant: { detail: { code: "cv1" } },
          entries: [
            {
              entryId: "e1",
              ownCode: "pv1",
              ownDetailCode: "cv1",
              name: "Widget",
              description: "A widget.",
            },
            {
              entryId: "e2",
              ownCode: "pv1-alt",
              ownDetailCode: "cv1-alt",
              name: "Gadget",
              description: "A gadget.",
            },
            {
              entryId: "e3",
              ownCode: "pv1-alt2",
              ownDetailCode: "cv1-alt3",
              name: "Doohickey",
              description: "A doohickey.",
            },
          ],
        },
        {
          masterCode: "grp2",
          primaryVariant: { code: "pv2" },
          cheapestVariant: { detail: { code: "cv2" } },
          entries: [
            {
              entryId: "e4",
              ownCode: "pv2",
              ownDetailCode: "cv2",
              name: "Thingamajig",
              description: "A thingamajig.",
            },
            {
              entryId: "e5",
              ownCode: "pv2-alt",
              ownDetailCode: "cv2-alt",
              name: "Contraption",
              description: "A contraption.",
            },
            {
              entryId: "e6",
              ownCode: "pv2-alt2",
              ownDetailCode: "cv2-alt3",
              name: "Gizmo",
              description: "A gizmo.",
            },
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
    expect(String(calls[1]![0])).toContain("code=pv1");
    expect(String(calls[1]![0])).toContain("detail=cv1");
    expect(String(calls[2]![0])).toContain("code=pv2");
    expect(String(calls[2]![0])).toContain("detail=cv2");
    expect(String(calls[3]![0])).toContain("code=zzz-unrelated");
    expect(String(calls[3]![0])).toContain("detail=zzz-unrelated-detail");
  });
});
