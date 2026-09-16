import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallTwoIndependentPrimariesNestedFieldLoopScopeActionSteps } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression coverage for the fold-hoist identifier-bleed bug: an
 * `itemVarRefPattern` anchored on `${itemVar` immediately after the
 * interpolation brace misses a nested field path's cast-wrapped accessor
 * (`${(itemVar.field as Record<string, unknown>)...}`), wrongly treats a
 * genuinely item-scoped chain fetch as ancestor-scoped, and hoists it above
 * its own item loop — emitting a reference to a loop variable that isn't
 * declared there. This pins the fix with TWO independent fold loops bound to
 * DIFFERENT loop-variable names (`item0`/`item1`) in one generated output, so
 * any future regression that lets one loop's body reference the other,
 * unrelated loop's bound identifier is caught.
 */

function emitBody(): string {
  const steps = buildMulticallTwoIndependentPrimariesNestedFieldLoopScopeActionSteps();
  const captures = steps.map((step) => step.capture);
  const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;
  const actionCaptures = captures.map((capture, index) => ({ capture, index }));
  const stateIndex = indexStateValues(captures);
  const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);

  return emitMultiStepExecuteHttp(
    actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
    inputBody,
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
 * — so a caller can assert what a SPECIFIC loop's own body does or doesn't
 * reference without the other loop's text contaminating the check. */
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
 * own header + body text — proof no reference was hoisted to a scope where
 * the loop var isn't declared, regardless of WHICH sibling scope it landed
 * in (the other loop's body, the shared ancestor scope between them, or top
 * level). `sliceLoopBody` alone only rules out landing inside a NAMED
 * sibling loop's own braces — a hoist into the shared ancestor scope above
 * both loops (this bug's actual failure mode) sits in neither slice. */
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

describe("recon-generate fold-hoist — out-of-scope loop-variable identifier bleed regression", () => {
  it("keeps each independent loop's own chain fetch lexically inside its own loop, never the other's", () => {
    const body = emitBody();

    // Both independent fold plans resolved — one per distinct loop-variable
    // name, proving this fixture actually exercises two separate scopes.
    expect(body).toContain("for (const item0 of");
    expect(body).toContain("for (const item1 of");

    const item0Body = sliceLoopBody(body, "item0");
    const item1Body = sliceLoopBody(body, "item1");

    // The regression: item1's own nested-path chain fetch must never be
    // hoisted above item1's loop — including into item0's own loop body,
    // which is the only other lexical scope available in this fixture.
    expect(item0Body).not.toMatch(/\bitem1\b/);
    expect(item1Body).not.toMatch(/\bitem0\b/);

    // Stronger than the two checks above: catches a hoist into the shared
    // ancestor scope between the two loops too, not just into the other
    // NAMED loop's own body — the actual failure mode of this bug (the
    // chain fetch is spliced above `item1`'s own `for` open, inside the
    // ancestor group loop, not inside `item0`'s loop).
    expect(occurrencesOutsideOwnLoop(body, "item0")).toEqual([]);
    expect(occurrencesOutsideOwnLoop(body, "item1")).toEqual([]);

    // item1's drill request must reference its OWN nested field, in the
    // cast-wrapped shape unknownValueAccessor emits for a non-leaf path hop
    // — the exact shape the anchored `${itemVar` pattern missed.
    expect(item1Body).toContain("(item1.identifiers as Record<string, unknown>).code");

    // Sanity: this must be a real per-item drill (the `code` differs across
    // e1/e2), not an ancestor-scoped one that would resolve once per group —
    // ruling out the fold plan disguising the identifier bleed as a
    // harmless hoist that happens to still resolve correctly.
    expect(body).not.toContain("code=code-e1");
    expect(body).not.toContain("code=code-e2");
  });

  it("at runtime, threads each loop's own item's own nested field with no cross-scope contamination", async () => {
    const body = emitBody();
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    const fn = vi.fn().mockImplementation((url: string, init?: { body?: string }) => {
      const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      const responseBody = (() => {
        if (typeof requestBody?.productId === "string") {
          return { reviews: [{ productId: requestBody.productId, rating: 5 }] };
        }
        if (url.includes("/catalog/entries/details?code=code-e1")) {
          return { details: [{ entryId: "e1", description: "d-e1" }] };
        }
        if (url.includes("/catalog/entries/details?code=code-e2")) {
          return { details: [{ entryId: "e2", description: "d-e2" }] };
        }
        if (url.includes("/catalog/entries/details")) {
          return { details: [] };
        }
        if (url.includes("/catalog/sections")) {
          return {
            sections: [
              {
                masterCode: "sec1",
                entries: [
                  { entryId: "e1", identifiers: { code: "code-e1" } },
                  { entryId: "e2", identifiers: { code: "code-e2" } },
                ],
              },
            ],
          };
        }
        return { products: [{ productId: "p1" }, { productId: "p2" }] };
      })();
      return Promise.resolve({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify(responseBody)),
        headers: new Headers(),
      });
    });
    vi.stubGlobal("fetch", fn);

    // Reaching this point without a ReferenceError already proves neither
    // loop's own block-scoped `const item0`/`item1` binding was referenced
    // outside its own `for` block — a hoisted reference to an undeclared
    // loop variable throws at the interpolation point, at eval-time.
    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    const data = result.data as {
      products?: Array<Record<string, unknown>>;
      sections?: Array<{ entries: Array<Record<string, unknown>> }>;
    };
    expect(data.products).toEqual([
      { productId: "p1", rating: 5 },
      { productId: "p2", rating: 5 },
    ]);
    expect(data.sections?.[0]?.entries).toEqual([
      { entryId: "e1", identifiers: { code: "code-e1" }, description: "d-e1" },
      { entryId: "e2", identifiers: { code: "code-e2" }, description: "d-e2" },
    ]);
  });
});
