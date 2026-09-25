import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallNestedGroupedDrillDownAncestorItemValueCoincidenceActionSteps } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression coverage for an ancestor-vs-item accessor-scope defect distinct
 * from the two sibling 1.12.52 pins: an ancestor group loop (`g0`) whose
 * hoisted chain fetch is spliced above a deeper `item` sub-loop over each
 * group's own nested array, where the drilled call's two params each name a
 * field genuinely present on BOTH the ancestor (nested one level inside its
 * own `tags` array) AND every one of its items (directly), holding the
 * identical value on both. A literal-value search over the captured request
 * necessarily lands on the item's own (shallower) field first, so a correct
 * fold plan must REBIND the rendered accessor onto the ancestor's structural
 * counterpart via a traversal into the ancestor's own nested array — a
 * fold plan that fails that rebind emits an accessor reading off the item
 * loop's own bound variable at a splice point where it is not yet declared.
 * Neither
 * `recon-generate-1-12-52-out-of-scope-loop-variable-identifier-e2e.test.ts`
 * (two independent item-only loops, no ancestor involved) nor
 * `recon-generate-1-12-52-ancestor-scoped-hoisted-call-identifier-bleed-e2e.test.ts`
 * (an ancestor-ONLY nested field, absent from the item scope entirely)
 * covers this dual-presence, value-coincident shape.
 */

const DUAL_PARAM_ANCESTOR_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/entries/details",
  resultsPath: "sections.*.entries",
  drillResultsPath: "details",
  joinFields: ["entryId"],
};

function emitBody(): string {
  const actionSteps = buildMulticallNestedGroupedDrillDownAncestorItemValueCoincidenceActionSteps();

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
    DUAL_PARAM_ANCESTOR_SPEC
  );
}

/** Slices out the source text lexically enclosed by a `for (const <loopVar>
 * of ...) { ... }` block, walking brace depth from the loop's own open brace
 * — mirrors the helper of the same name in the two sibling 1.12.52 tests. */
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
 * own header + body text — mirrors the helper of the same name in the two
 * sibling 1.12.52 tests. */
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

describe("recon-generate fold-hoist — ancestor/item value-coincidence hoisted accessor scope regression", () => {
  it("hoists the chain fetch above the item loop, binding both drill params to the ancestor's own nested fields, never the item loop's", () => {
    const body = emitBody();

    const groupLoopIndex = body.indexOf("for (const g0 of");
    const drillFetchCallIndex = body.indexOf("catalog/entries/details?code=");
    const itemLoopIndex = body.indexOf("for (const item of");

    expect(groupLoopIndex).toBeGreaterThanOrEqual(0);
    expect(drillFetchCallIndex).toBeGreaterThanOrEqual(0);
    expect(itemLoopIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeLessThan(itemLoopIndex);

    // No bare `item`-named identifier ever appears outside the item loop's
    // own braces, including at the hoisted call site above it.
    const itemBody = sliceLoopBody(body, "item");
    expect(itemBody).not.toContain("await httpClient(");
    expect(occurrencesOutsideOwnLoop(body, "item")).toEqual([]);

    // Both independently-resolved params must read off the ancestor's own
    // nested `tags[0]` fields, never the item loop's bound variable — even
    // though `item.code`/`item.zone` would have resolved to the identical
    // literal value for the matched item.
    const DRILL_URL_ACCESSOR =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      'catalog/entries/details?code=${(((g0 as Record<string, unknown>).tags as Record<string, unknown>)["0"] as Record<string, unknown>).code}&zone=${(((g0 as Record<string, unknown>).tags as Record<string, unknown>)["0"] as Record<string, unknown>).zone}';
    expect(body).toContain(DRILL_URL_ACCESSOR);
    expect(body).not.toContain("catalog/entries/details?code=${item");
    expect(body).not.toContain("zone=${item");
  });

  it("at runtime, resolves both drill params off the ancestor group's nested field and threads the correct value onto every item, with no ReferenceError", async () => {
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
            masterCode: "group-sec1",
            tags: [{ code: "meta-code-1", zone: "west" }],
            entries: [
              { entryId: "e1", code: "meta-code-1", zone: "west", name: "Widget" },
              { entryId: "e2", code: "e2-own-code", zone: "e2-own-zone", name: "Gadget" },
            ],
          },
          {
            masterCode: "group-sec2",
            tags: [{ code: "meta-code-2", zone: "east" }],
            entries: [
              { entryId: "e3", code: "meta-code-2", zone: "east", name: "Thingamajig" },
              { entryId: "e4", code: "e4-own-code", zone: "e4-own-zone", name: "Contraption" },
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
        text: vi.fn().mockResolvedValue(JSON.stringify(responseBody)),
        headers: new Headers(),
      });
    }
    vi.stubGlobal("fetch", fn);

    // Reaching this point without a ReferenceError already proves neither
    // hoisted param ever referenced the undeclared `item` binding.
    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com" });

    expect(result.data).toEqual({
      sections: [
        {
          masterCode: "group-sec1",
          tags: [{ code: "meta-code-1", zone: "west" }],
          entries: [
            {
              entryId: "e1",
              code: "meta-code-1",
              zone: "west",
              name: "Widget",
              description: "A widget.",
            },
            {
              entryId: "e2",
              code: "e2-own-code",
              zone: "e2-own-zone",
              name: "Gadget",
              description: "A gadget.",
            },
          ],
        },
        {
          masterCode: "group-sec2",
          tags: [{ code: "meta-code-2", zone: "east" }],
          entries: [
            {
              entryId: "e3",
              code: "meta-code-2",
              zone: "east",
              name: "Thingamajig",
              description: "A thingamajig.",
            },
            {
              entryId: "e4",
              code: "e4-own-code",
              zone: "e4-own-zone",
              name: "Contraption",
              description: "A contraption.",
            },
          ],
        },
      ],
    });

    // Exactly one drill fetch per group (not once per item, which would
    // make 5), plus the primary fetch and the fixture's own trailing decoy.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(4);
    expect(String(calls[1]![0])).toContain("code=meta-code-1");
    expect(String(calls[1]![0])).toContain("zone=west");
    expect(String(calls[2]![0])).toContain("code=meta-code-2");
    expect(String(calls[2]![0])).toContain("zone=east");
    expect(String(calls[3]![0])).toContain("code=zzz-unrelated");
  });
});
