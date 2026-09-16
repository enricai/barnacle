import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import {
  buildMulticallNestedGroupedDrillDownTwoLevelNestedAncestorFieldActionSteps,
  buildMulticallOrdersLineItemPromoEligibilityActionSteps,
} from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression coverage for the distinct shape reported between 1.12.52 and
 * 1.12.51-fixed: a fold-hoisted chain call living directly inside a
 * `g0`-named ancestor loop, with NO `item` sub-loop of its own supplying that
 * call's binding, coexisting in the SAME generated output with a wholly
 * separate, later, structurally unrelated action whose own fold legitimately
 * declares a bare `item` loop variable. This is distinct from
 * `recon-generate-1-12-52-ancestor-scoped-hoisted-call-identifier-bleed-e2e.test.ts`
 * (single `g0` ancestor + single `item` sub-loop, both belonging to the SAME
 * fold plan) and from
 * `recon-generate-1-12-52-out-of-scope-loop-variable-identifier-e2e.test.ts`
 * (two independently-scoped `item0`/`item1` loops from ONE call, both
 * correctly declared) — here the only `item` binding anywhere in the combined
 * output belongs to a completely different, later `emitMultiStepExecuteHttp`
 * invocation, so any bleed can only be explained by state leaking ACROSS
 * generator invocations, not by a within-plan scoping mistake.
 */

const NESTED_ANCESTOR_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/entries/details",
  resultsPath: "sections.*.entries",
  drillResultsPath: "details",
  joinFields: ["entryId"],
};

const LINE_ITEM_PROMO_SPEC: FoldReturnSpec = {
  endpointPattern: "orders/promo-eligibility",
  resultsPath: "lineItems",
  drillResultsPath: "eligibility",
  joinFields: ["sku"],
};

function emitAncestorOnlyGroupBody(): string {
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

function emitUnrelatedItemLoopBody(): string {
  const actionSteps = buildMulticallOrdersLineItemPromoEligibilityActionSteps();

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
    LINE_ITEM_PROMO_SPEC
  );
}

/** Every `for (const <loopVar> of ...) { ... }` block's own body text, walked
 * via brace depth from each occurrence's own open brace — a generalization of
 * the single-occurrence `sliceLoopBody` helper used by the sibling regression
 * tests, needed here because `item` may legitimately be declared MORE THAN
 * ONCE across a combined multi-function output (once, unused, inside this
 * fixture's own ancestor-only ownership loop; once, for real, inside the
 * wholly separate later function). */
function allLoopBodySpans(body: string, loopVar: string): Array<{ start: number; end: number }> {
  const openMarker = `for (const ${loopVar} of`;
  const spans: Array<{ start: number; end: number }> = [];
  let searchFrom = 0;
  for (;;) {
    const markerIndex = body.indexOf(openMarker, searchFrom);
    if (markerIndex === -1) break;
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
    if (loopEnd === -1) {
      throw new Error(`allLoopBodySpans: unterminated "${openMarker}" loop body`);
    }
    // Span covers the loop's own header (`for (const <loopVar> of ...) {`)
    // through its closing brace, not just the inner body — the header
    // itself is where `loopVar` is declared, so a bare inner-body-only span
    // would wrongly flag the declaration itself as an "outside" occurrence.
    spans.push({ start: markerIndex, end: loopEnd });
    searchFrom = loopEnd;
  }
  return spans;
}

/** Every occurrence of `\b<loopVar>\b` anywhere in `body` OUTSIDE every span
 * where `loopVar` is legitimately declared — mirrors `occurrencesOutsideOwnLoop`
 * from the sibling regression tests, generalized to multiple legitimate
 * declarations of the same loop-variable name across a combined multi-function
 * output (see {@link allLoopBodySpans}). */
function occurrencesOutsideEveryOwnLoop(body: string, loopVar: string): string[] {
  const spans = allLoopBodySpans(body, loopVar);
  const outside = spans
    .slice()
    .sort((a, b) => a.start - b.start)
    .reduceRight(
      (remaining, span) => `${remaining.slice(0, span.start)}${remaining.slice(span.end)}`,
      body
    );
  return outside.match(new RegExp(`\\b${loopVar}\\b`, "g")) ?? [];
}

describe("recon-generate fold-hoist — ancestor loop with no item sibling, cross-scope item bleed regression", () => {
  it("keeps the g0-scoped hoisted call bound to g0's own field, never to an item identifier declared only in a separate, later, unrelated function", () => {
    const ancestorBody = emitAncestorOnlyGroupBody();
    const unrelatedBody = emitUnrelatedItemLoopBody();
    const combinedBody = `${ancestorBody}\n${unrelatedBody}`;

    // Both functions actually resolved the shapes this test depends on.
    expect(combinedBody).toContain("for (const g0 of");
    expect(combinedBody).toContain("for (const item of");

    // The g0-scoped hoisted call reads only g0's own nested field.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(ancestorBody).toContain("catalog/entries/details?code=${g0.meta.summary.code}");
    expect(ancestorBody).not.toContain("catalog/entries/details?code=${item");

    // The separate, later function's own drill call legitimately reads its
    // own item's own field — this is the "separate, later, unrelated loop
    // that legitimately declares item" the regression must never contaminate.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(unrelatedBody).toContain('body: `{"sku":"${item.sku}"}`');

    // The regression: no `item` reference anywhere in the combined output
    // lands outside every legitimately-declared `item` loop body — including
    // the g0-scoped hoisted call above, which has no item sub-loop of its
    // own supplying a binding for it.
    expect(occurrencesOutsideEveryOwnLoop(combinedBody, "item")).toEqual([]);
  });

  it("at runtime, each function evaluates independently without a ReferenceError, threading its own value correctly scoped", async () => {
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    const ancestorFetch = vi.fn();
    for (const responseBody of [
      {
        sections: [
          {
            masterCode: "group-sec1",
            meta: { summary: { code: "meta-code-1" } },
            entries: [{ entryId: "e1", ownCode: "meta-code-1", name: "Widget" }],
          },
        ],
      },
      { details: [{ entryId: "e1", description: "A widget." }] },
      { details: [{ entryId: "zzz-unrelated", description: "An unrelated entry." }] },
    ]) {
      ancestorFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify(responseBody)),
        headers: new Headers(),
      });
    }
    vi.stubGlobal("fetch", ancestorFetch);

    // Reaching this point without a ReferenceError already proves the
    // ancestor-only, no-item-sibling hoisted call never referenced an
    // undeclared `item` binding.
    const ancestorExecuteHttp = evalExecuteHttpBody(emitAncestorOnlyGroupBody(), httpClient, z);
    const ancestorResult = await ancestorExecuteHttp({ BaseUrl: "https://api.example.com" });
    expect(ancestorResult.data).toEqual({
      sections: [
        {
          masterCode: "group-sec1",
          meta: { summary: { code: "meta-code-1" } },
          entries: [
            { entryId: "e1", ownCode: "meta-code-1", name: "Widget", description: "A widget." },
          ],
        },
      ],
    });

    const unrelatedFetch = vi.fn();
    for (const responseBody of [
      { lineItems: [{ sku: "sku-a", quantity: 2 }] },
      { eligibility: [{ sku: "sku-a", eligible: true }] },
    ]) {
      unrelatedFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify(responseBody)),
        headers: new Headers(),
      });
    }
    vi.stubGlobal("fetch", unrelatedFetch);

    const unrelatedExecuteHttp = evalExecuteHttpBody(emitUnrelatedItemLoopBody(), httpClient, z);
    const unrelatedResult = await unrelatedExecuteHttp({ BaseUrl: "https://api.example.com" });
    expect(unrelatedResult.data).toEqual({
      lineItems: [{ sku: "sku-a", quantity: 2, eligible: true }],
    });
  });
});
