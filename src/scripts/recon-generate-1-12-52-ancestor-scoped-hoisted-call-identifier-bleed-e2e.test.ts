import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallNestedGroupedDrillDownTwoLevelNestedAncestorFieldActionSteps } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression coverage for the exact structural shape reported between
 * 1.12.51 and 1.12.52: an ancestor group loop (`g0`) with NO separate item
 * sub-loop wrapping its own hoisted chain fetch, where the drilled value is
 * reached two levels deep off the ancestor's own object
 * (`g0.meta.summary.code`). The report's failure substituted a totally
 * unrelated `item` identifier — never declared anywhere in this scope — for
 * the correct ancestor binding, breaking compilation and value threading at
 * exactly this ancestor-scoped-nested-field call site. This is distinct
 * from `recon-generate-1-12-52-out-of-scope-loop-variable-identifier-e2e.test.ts`'s
 * item0/item1 cross-loop bleed shape, which pins two independent
 * ITEM-scoped loops, not an ancestor-only hoist.
 */

const NESTED_ANCESTOR_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/entries/details",
  resultsPath: "sections.*.entries",
  drillResultsPath: "details",
  joinFields: ["entryId"],
};

function emitBody(): string {
  const actionSteps = buildMulticallNestedGroupedDrillDownTwoLevelNestedAncestorFieldActionSteps();

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
    NESTED_ANCESTOR_SPEC
  );
}

/** Slices out the source text lexically enclosed by a `for (const <loopVar>
 * of ...) { ... }` block, walking brace depth from the loop's own open brace
 * — mirrors the helper of the same name in
 * recon-generate-1-12-52-out-of-scope-loop-variable-identifier-e2e.test.ts,
 * reused here rather than reimplemented. */
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
 * recon-generate-1-12-52-out-of-scope-loop-variable-identifier-e2e.test.ts. */
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

describe("recon-generate fold-hoist — ancestor-scoped nested-field hoisted call identifier bleed regression", () => {
  it("hoists the chain fetch above the item loop, bound only to the ancestor's own nested field, never the item-loop's variable", () => {
    const body = emitBody();

    const groupLoopIndex = body.indexOf("for (const g0 of");
    const drillFetchCallIndex = body.indexOf("catalog/entries/details?code=");
    const itemLoopIndex = body.indexOf("for (const item of");

    expect(groupLoopIndex).toBeGreaterThanOrEqual(0);
    expect(drillFetchCallIndex).toBeGreaterThanOrEqual(0);
    expect(itemLoopIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeLessThan(itemLoopIndex);

    // The regression: the hoisted call must read the ancestor's own
    // two-level-nested field, never the item-loop's own bound variable —
    // the item loop's own slice must never leak into the ancestor-scoped
    // call site above it, and vice versa.
    const itemBody = sliceLoopBody(body, "item");
    expect(itemBody).not.toContain("await httpClient(");
    expect(occurrencesOutsideOwnLoop(body, "item")).toEqual([]);

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(body).toContain(
      "catalog/entries/details?code=${(((g0 as Record<string, unknown>).meta as Record<string, unknown>).summary as Record<string, unknown>).code}"
    );
    expect(body).not.toContain("catalog/entries/details?code=${item");
  });

  it("at runtime, calls the drill endpoint exactly once per group (not once per item) without a ReferenceError", async () => {
    const body = emitBody();
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    const fn = vi.fn();
    for (const body of [
      {
        sections: [
          {
            masterCode: "group-sec1",
            meta: { summary: { code: "meta-code-1" } },
            entries: [
              { entryId: "e1", ownCode: "meta-code-1", name: "Widget" },
              { entryId: "e2", ownCode: "e2-own-code", name: "Gadget" },
            ],
          },
          {
            masterCode: "group-sec2",
            meta: { summary: { code: "meta-code-2" } },
            entries: [
              { entryId: "e3", ownCode: "meta-code-2", name: "Thingamajig" },
              { entryId: "e4", ownCode: "e4-own-code", name: "Contraption" },
            ],
          },
        ],
      },
      {
        details: [
          { entryId: "e1", description: "A widget." },
          { entryId: "e2", description: "A gadget." },
        ],
      },
      {
        details: [
          { entryId: "e3", description: "A thingamajig." },
          { entryId: "e4", description: "A contraption." },
        ],
      },
      { details: [] },
    ]) {
      fn.mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify(body)),
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
          masterCode: "group-sec1",
          meta: { summary: { code: "meta-code-1" } },
          entries: [
            {
              entryId: "e1",
              ownCode: "meta-code-1",
              name: "Widget",
              description: "A widget.",
            },
            { entryId: "e2", ownCode: "e2-own-code", name: "Gadget", description: "A gadget." },
          ],
        },
        {
          masterCode: "group-sec2",
          meta: { summary: { code: "meta-code-2" } },
          entries: [
            {
              entryId: "e3",
              ownCode: "meta-code-2",
              name: "Thingamajig",
              description: "A thingamajig.",
            },
            {
              entryId: "e4",
              ownCode: "e4-own-code",
              name: "Contraption",
              description: "A contraption.",
            },
          ],
        },
      ],
    });

    // Exactly 4 fetches: the primary, one drill per group (not once per
    // item, which would make 5), plus the fixture's own trailing decoy call.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(4);
    expect(String(calls[1]![0])).toContain("code=meta-code-1");
    expect(String(calls[2]![0])).toContain("code=meta-code-2");
    expect(String(calls[3]![0])).toContain("code=zzz-unrelated");
  });
});
