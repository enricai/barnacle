import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallAncestorScopedDualThreadedFieldDrillDownActionSteps } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression coverage for the `buildThreadedFieldPairs` `?? tf` fallback
 * path the 1.12.52 report's fold-hoist fix investigates: an ancestor-scoped
 * drill target whose request threads TWO fields — the declared join field
 * (`entryId`) AND a second, independently-discovered field (`regionCode`)
 * that `findThreadedJoinFields` picks up purely because its literal value
 * sits in the request, never named in `joinFields`. Each field's own
 * structural rebind is resolved independently by `buildThreadedFieldPairs`,
 * and the hoist gate's `referencesItemVar` ground-truth signal is likewise
 * computed per value/placeholder binding rather than by a single post-hoc
 * scan of the fully rendered text — a target with two co-resolved fields
 * exercises that per-field computation the way a single-field target (see
 * `recon-generate-1-12-52-ancestor-scoped-hoisted-call-identifier-bleed-e2e.test.ts`)
 * cannot. Site-agnostic (catalog/entries), per this repo's plugin-neutral
 * regression-test convention.
 */

const DUAL_FIELD_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/entries/labels",
  resultsPath: "sections.*.entries",
  drillResultsPath: "labels",
  joinFields: ["entryId"],
};

function emitBody(): string {
  const actionSteps = buildMulticallAncestorScopedDualThreadedFieldDrillDownActionSteps();

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
    DUAL_FIELD_SPEC
  );
}

/** Slices out the source text lexically enclosed by a `for (const <loopVar>
 * of ...) { ... }` block, walking brace depth from the loop's own open brace
 * — mirrors the helper of the same name in
 * recon-generate-1-12-52-ancestor-scoped-hoisted-call-identifier-bleed-e2e.test.ts. */
function sliceLoopBody(body: string, loopVar: string): string {
  const openMarker = `for (const ${loopVar} of`;
  const markerIndex = body.indexOf(openMarker);
  if (markerIndex === -1) {
    throw new Error(`sliceLoopBody: no "${openMarker}" loop found in the emitted body`);
  }
  const braceStart = body.indexOf("{", markerIndex);
  let depth = 0;
  for (let i = braceStart; i < body.length; i++) {
    if (body[i] === "{") depth++;
    if (body[i] === "}") {
      depth--;
      if (depth === 0) return body.slice(braceStart + 1, i);
    }
  }
  throw new Error(`sliceLoopBody: unterminated "${openMarker}" loop body`);
}

/** Every occurrence of `\b<loopVar>\b` anywhere in `body` OUTSIDE that loop's
 * own header + body text — mirrors the helper of the same name in
 * recon-generate-1-12-52-ancestor-scoped-hoisted-call-identifier-bleed-e2e.test.ts. */
function occurrencesOutsideOwnLoop(body: string, loopVar: string): string[] {
  const openMarker = `for (const ${loopVar} of`;
  const markerIndex = body.indexOf(openMarker);
  const braceStart = body.indexOf("{", markerIndex);
  let depth = 0;
  let loopEnd = -1;
  for (let i = braceStart; i < body.length; i++) {
    if (body[i] === "{") depth++;
    if (body[i] === "}") {
      depth--;
      if (depth === 0) {
        loopEnd = i + 1;
        break;
      }
    }
  }
  const outside = body.slice(0, markerIndex) + body.slice(loopEnd);
  return outside.match(new RegExp(`\\b${loopVar}\\b`, "g")) ?? [];
}

describe("recon-generate fold-hoist — ancestor-scoped dual-threaded-field fallback identifier scope regression", () => {
  it("hoists the drill above the item loop, rebinding BOTH threaded fields to the ancestor's own array, never the item loop's variable", () => {
    const body = emitBody();

    const groupLoopIndex = body.indexOf("for (const g0 of");
    const drillCallIndex = body.indexOf("catalog/entries/labels?code=");
    const itemLoopIndex = body.indexOf("for (const item of");

    expect(groupLoopIndex).toBeGreaterThanOrEqual(0);
    expect(drillCallIndex).toBeGreaterThanOrEqual(0);
    expect(itemLoopIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillCallIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillCallIndex).toBeLessThan(itemLoopIndex);

    // The item loop's own bound identifier must never leak outside its own
    // loop, and the hoisted call must never sit inside the item loop's body.
    const itemBody = sliceLoopBody(body, "item");
    expect(itemBody).not.toContain("await httpClient(");
    expect(occurrencesOutsideOwnLoop(body, "item")).toEqual([]);

    // Both threaded fields — the declared join field AND the
    // independently-discovered second field — must rebind through the
    // ancestor's own nested array, never through an `item`-rooted accessor.
    expect(body).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      'catalog/entries/labels?code=${(((g0 as Record<string, unknown>).entries as Record<string, unknown>)["0"] as Record<string, unknown>).entryId}&region=${(((g0 as Record<string, unknown>).entries as Record<string, unknown>)["0"] as Record<string, unknown>).regionCode}'
    );
    expect(body).not.toContain("catalog/entries/labels?code=${item");
    expect(body).not.toContain("region=${item");
  });

  it("at runtime, calls the drill endpoint exactly once per group (not once per item), joining both fields' labels onto every item without a ReferenceError", async () => {
    const body = emitBody();
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    const fn = vi.fn();
    for (const responseBody of [
      {
        sections: [
          {
            masterCode: "sec1",
            entries: [
              { entryId: "e1", regionCode: "north", name: "Widget" },
              { entryId: "e2", regionCode: "north", name: "Gadget" },
              { entryId: "e3", regionCode: "north", name: "Doohickey" },
            ],
          },
          {
            masterCode: "sec2",
            entries: [
              { entryId: "e4", regionCode: "south", name: "Thingamajig" },
              { entryId: "e5", regionCode: "south", name: "Contraption" },
              { entryId: "e6", regionCode: "south", name: "Gizmo" },
            ],
          },
        ],
      },
      {
        labels: [
          { entryId: "e1", label: "north-widget" },
          { entryId: "e2", label: "north-gadget" },
          { entryId: "e3", label: "north-doohickey" },
        ],
      },
      {
        labels: [
          { entryId: "e4", label: "south-thingamajig" },
          { entryId: "e5", label: "south-contraption" },
          { entryId: "e6", label: "south-gizmo" },
        ],
      },
      { labels: [] },
    ]) {
      fn.mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify(responseBody)),
        headers: new Headers(),
      });
    }
    vi.stubGlobal("fetch", fn);

    // Reaching this point without a ReferenceError already proves the
    // hoisted call never referenced an undeclared `item` binding.
    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com" });

    expect(result.data).toEqual({
      sections: [
        {
          masterCode: "sec1",
          entries: [
            { entryId: "e1", regionCode: "north", name: "Widget", label: "north-widget" },
            { entryId: "e2", regionCode: "north", name: "Gadget", label: "north-gadget" },
            {
              entryId: "e3",
              regionCode: "north",
              name: "Doohickey",
              label: "north-doohickey",
            },
          ],
        },
        {
          masterCode: "sec2",
          entries: [
            {
              entryId: "e4",
              regionCode: "south",
              name: "Thingamajig",
              label: "south-thingamajig",
            },
            {
              entryId: "e5",
              regionCode: "south",
              name: "Contraption",
              label: "south-contraption",
            },
            { entryId: "e6", regionCode: "south", name: "Gizmo", label: "south-gizmo" },
          ],
        },
      ],
    });

    // 4 fetches: the primary, one drill per group (2 groups), plus the
    // fixture's own trailing decoy call.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(4);
  });
});
