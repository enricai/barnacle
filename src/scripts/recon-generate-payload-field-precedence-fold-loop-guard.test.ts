import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Reproduces the report's exact shape through a REAL structural fold/drill
 * loop (`detectDrillDownFoldPlan`, not the manually force-included isolation
 * `recon-generate-1-12-51-payload-field-priority-across-all-calls-guard.test.ts`
 * deliberately avoids): a top-level scalar (`region`) is legitimately sourced
 * from `payload.region` by exact-name match on the search call — the same
 * value the per-item drill call both re-sends and echoes back nested at
 * `meta.region`, forming a {@link deriveProducerBoundaryBindings}
 * producer-boundary binding scoped to the drill step. Before the fix,
 * `interpolateStateValues`'s producer-boundary exemption was a step-agnostic
 * `ReadonlySet<string>`, so that ONE binding suppressed payload precedence for
 * "west-region" on EVERY call in the function, not just the drill step that
 * earned it — letting a later, unrelated submit call thread the scraped
 * `meta.region` state var instead of `payload.region`.
 */

const SEARCH_URL = "https://api.example.com/catalog/search/";
const DRILL_URL = "https://api.example.com/catalog/detail/";
const SUBMIT_URL = "https://api.example.com/catalog/submit/";

const REGION_VALUE = "west-region";

function buildFixtureCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    // Search: entry payload's own top-level "region" field — the legitimate
    // payload source every other call's same-named field must keep deferring to.
    buildCapture({
      url: SEARCH_URL,
      requestPostData: JSON.stringify({ region: REGION_VALUE, page: 1 }),
      responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
      timestamp: "2024-06-01T00:00:00Z",
    }),
    // Per-item drill (the sole capture `detectDrillDownFoldPlan` folds across
    // both primary items via the "sku" join): re-sends "region" in its OWN
    // request body AND echoes it nested at meta.region in its response —
    // exactly the produced-and-re-sent shape `deriveProducerBoundaryBindings`
    // scopes to THIS step alone.
    buildCapture({
      url: DRILL_URL,
      requestPostData: JSON.stringify({ sku: "sku-a", region: REGION_VALUE }),
      responseBody: { sku: "sku-a", meta: { region: REGION_VALUE }, price: 19.99 },
      timestamp: "2024-06-01T00:00:01Z",
    }),
    // Submit: a later, unrelated (non-producer, non-fold) call re-sending
    // "region" under the same key — must still read payload.region, never the
    // scraped meta.region accessor the drill step's producer-boundary binding
    // wrongly tainted every other call with before the fix.
    buildCapture({
      url: SUBMIT_URL,
      requestPostData: JSON.stringify({ sku: "sku-a", region: REGION_VALUE }),
      responseBody: { ok: true },
      timestamp: "2024-06-01T00:00:02Z",
    }),
  ];
}

describe("recon-generate emitMultiStepExecuteHttp — payload field precedence across a real fold/drill loop", () => {
  it("sources a payload-matched field from payload.<field> on every call, including inside the fold loop and on a later unrelated call, never from the producer-boundary-tainted scraped accessor", () => {
    const captures = buildFixtureCaptures();
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;
    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures);
    const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);

    const body = emitMultiStepExecuteHttp(
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

    // A real structural fold loop was actually emitted for this fixture —
    // otherwise this test would silently degrade into the non-fold guard
    // that already exists.
    expect(body).toContain("for (const item of foldItems)");

    const regionOccurrences = [...body.matchAll(/"region"\s*:\s*"?([^,\n}]*)"?/g)];
    expect(regionOccurrences.length).toBeGreaterThanOrEqual(2);
    for (const match of regionOccurrences) {
      expect(match[1], body).toContain("payload.region");
    }

    // Never sourced from the coincidentally-equal scraped meta.region accessor
    // on any call.
    expect(body).not.toMatch(/"region"\s*:\s*"?\$\{[^}]*meta[^}]*\}/i);

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(body).not.toMatch(/\$\{[^}]*\$\{/);
  });
});
