import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallAncestorOnlyMultiTargetDrillDownActionSteps } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression coverage for the exact reported shape: TWO co-hoisted,
 * ancestor-only drill targets sharing a single ancestor group loop (`g0`),
 * with no item sub-loop wrapping either hoisted call. The reported defect
 * let a proven-ancestor-scoped target's hoist decision get computed off the
 * final rendered text rather than the value bindings that actually feed the
 * splice, so a sibling target's own unresolved rebind could still leak the
 * item loop's own bound identifier into a call site sitting above the item
 * loop's own declaration, where it is not yet in scope. Mirrors the
 * established pattern from
 * recon-generate-1-12-52-ancestor-scoped-hoisted-call-identifier-bleed-e2e.test.ts,
 * generalized to two independent targets at once.
 */

function emitBody(): string {
  const actionSteps = buildMulticallAncestorOnlyMultiTargetDrillDownActionSteps();

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
    new Map()
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

describe("recon-generate fold-hoist — ancestor-only multi-target hoisted call identifier scope regression", () => {
  it("hoists BOTH drill targets above the item loop, each bound only to the ancestor's own field, never the item loop's variable", () => {
    const body = emitBody();

    const groupLoopIndex = body.indexOf("for (const g0 of");
    const detailsCallIndex = body.indexOf("catalog/entries/details?code=");
    const labelsCallIndex = body.indexOf("catalog/entries/labels?tag=");
    const itemLoopIndex = body.indexOf("for (const item of");

    expect(groupLoopIndex).toBeGreaterThanOrEqual(0);
    expect(detailsCallIndex).toBeGreaterThanOrEqual(0);
    expect(labelsCallIndex).toBeGreaterThanOrEqual(0);
    expect(itemLoopIndex).toBeGreaterThan(groupLoopIndex);

    expect(detailsCallIndex).toBeGreaterThan(groupLoopIndex);
    expect(detailsCallIndex).toBeLessThan(itemLoopIndex);
    expect(labelsCallIndex).toBeGreaterThan(groupLoopIndex);
    expect(labelsCallIndex).toBeLessThan(itemLoopIndex);

    // Neither hoisted call may sit inside the item loop's own body, and the
    // item loop's own bound identifier must never leak outside its own loop.
    const itemBody = sliceLoopBody(body, "item");
    expect(itemBody).not.toContain("await httpClient(");
    expect(occurrencesOutsideOwnLoop(body, "item")).toEqual([]);

    // Both drills must rebind through the ancestor's own nested array,
    // never through an `item`-rooted accessor.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(body).toContain(
      'catalog/entries/details?code=${(((g0 as Record<string, unknown>).entries as Record<string, unknown>)["0"] as Record<string, unknown>).entryId}'
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(body).toContain(
      'catalog/entries/labels?tag=${(((g0 as Record<string, unknown>).entries as Record<string, unknown>)["0"] as Record<string, unknown>).entryId}'
    );
    expect(body).not.toContain("catalog/entries/details?code=${item");
    expect(body).not.toContain("catalog/entries/labels?tag=${item");
  });

  it("at runtime, calls each drill endpoint exactly once per group (not once per item), joining both targets' fields onto every item without a ReferenceError", async () => {
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
              { entryId: "e1", name: "Widget" },
              { entryId: "e2", name: "Gadget" },
              { entryId: "e3", name: "Doohickey" },
            ],
          },
          {
            masterCode: "sec2",
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
        labels: [
          { entryId: "e1", label: "north-widget" },
          { entryId: "e2", label: "north-gadget" },
          { entryId: "e3", label: "north-doohickey" },
        ],
      },
      {
        details: [
          { entryId: "e4", description: "A thingamajig." },
          { entryId: "e5", description: "A contraption." },
          { entryId: "e6", description: "A gizmo." },
        ],
      },
      {
        labels: [
          { entryId: "e4", label: "south-thingamajig" },
          { entryId: "e5", label: "south-contraption" },
          { entryId: "e6", label: "south-gizmo" },
        ],
      },
      { details: [] },
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

    // Reaching this point without a ReferenceError already proves neither
    // hoisted call ever referenced an undeclared `item` binding.
    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com" });

    expect(result.data).toEqual({
      sections: [
        {
          masterCode: "sec1",
          entries: [
            { entryId: "e1", name: "Widget", description: "A widget.", label: "north-widget" },
            { entryId: "e2", name: "Gadget", description: "A gadget.", label: "north-gadget" },
            {
              entryId: "e3",
              name: "Doohickey",
              description: "A doohickey.",
              label: "north-doohickey",
            },
          ],
        },
        {
          masterCode: "sec2",
          entries: [
            {
              entryId: "e4",
              name: "Thingamajig",
              description: "A thingamajig.",
              label: "south-thingamajig",
            },
            {
              entryId: "e5",
              name: "Contraption",
              description: "A contraption.",
              label: "south-contraption",
            },
            { entryId: "e6", name: "Gizmo", description: "A gizmo.", label: "south-gizmo" },
          ],
        },
      ],
    });

    // 7 fetches: the primary, one details+labels drill per group (2 groups x
    // 2 targets = 4), plus the fixture's own two trailing decoy calls.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(7);
  });
});
