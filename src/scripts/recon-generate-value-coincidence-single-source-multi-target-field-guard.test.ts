import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Unit-level (direct `emitMultiStepExecuteHttp` call, no CLI/tsc round trip)
 * sibling of the CLI e2e value-coincidence guard tests: pins that a SINGLE
 * response-produced value which coincidentally equals the true values of TWO
 * differently-named fields in a later request body gets spliced into AT MOST
 * the name-correlated field — the other field must stay its own literal or a
 * distinctly-sourced accessor, never the same `${varName}` placeholder the
 * name-correlated field used. Modeled on the direct
 * `compileActionSteps`/`indexStateValues`/`emitMultiStepExecuteHttp` call
 * chain used by recon-generate-fold-drill-loop-value-coincidence-threading-guard-runtime-e2e.test.ts
 * (kept linear/non-fold here — a single-item, non-array-of-objects primary —
 * to isolate this from that sibling's fold-loop-specific threading path),
 * for a tight unit-level feedback loop distinct from the slower spawnSync CLI
 * harness the sibling e2e specs (test-001/002/003) use.
 */

const SEARCH_URL = "https://api.example.com/catalog/search/";
const DETAIL_URL = "https://api.example.com/catalog/detail/";
const SUBMIT_URL = "https://api.example.com/catalog/submit/";

// Long enough to clear MIN_STATE_VALUE_LENGTH (8) on its own merits, so
// eligibility is never in question — only the splice-site name correlation is.
const REGION_LABEL_VALUE = "north-america-east-1";

function buildSingleSourceMultiTargetCoincidenceCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    // Deliberately no object-array field in the primary response — a linear
    // chain, not a per-item fold/drill loop (resolveFoldPlan only triggers
    // off an array-of-objects primary), so the produced value under test
    // reaches the splice site via plain state-value threading.
    buildCapture({
      url: SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: { sku: "sku-a" },
      timestamp: "2024-08-01T00:00:00Z",
    }),
    buildCapture({
      url: DETAIL_URL,
      requestPostData: '{"sku":"sku-a"}',
      // The only produced value under test: named "regionLabel", correlating
      // with the submit body's own "region" field but with nothing at all in
      // common with "billingZone".
      responseBody: { sku: "sku-a", regionLabel: REGION_LABEL_VALUE },
      timestamp: "2024-08-01T00:00:01Z",
    }),
    buildCapture({
      url: SUBMIT_URL,
      // Nested (not top-level) so `applyPayloadKeyValueSubstitutions` never
      // payload-ifies these keys before the state-value splice site runs —
      // a top-level scalar body key is unconditionally payload-ified first,
      // which would mask the coincidence this test targets. "region" is
      // name-correlated to "regionLabel"; "billingZone" merely coincides in
      // VALUE with no name correlation at all.
      requestPostData: JSON.stringify({
        sku: "sku-a",
        details: { region: REGION_LABEL_VALUE, billingZone: REGION_LABEL_VALUE },
      }),
      responseBody: { ok: true },
      timestamp: "2024-08-01T00:00:02Z",
    }),
  ];
}

describe("recon-generate emitMultiStepExecuteHttp — single-source, multi-target-name value coincidence guard", () => {
  it("splices the produced value's placeholder into at most the name-correlated body key, never into a differently-named coincident key too", () => {
    const captures = buildSingleSourceMultiTargetCoincidenceCaptures();
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

    const regionLine = body.match(/"region"\s*:\s*"?\$\{([^}]*)\}"?/);
    expect(regionLine, body).not.toBeNull();
    const regionAccessor = regionLine![1]!;
    expect(regionAccessor).toMatch(/regionlabel/i);

    const billingZoneLine = body.match(/"billingZone"\s*:\s*"?([^,\n}]*)"?/);
    expect(billingZoneLine, body).not.toBeNull();
    const billingZoneRhs = billingZoneLine![1]!;
    if (billingZoneRhs.includes("${")) {
      // If it did resolve to an accessor, it must be a genuinely distinct
      // source, never the same regionLabel-derived placeholder.
      expect(billingZoneRhs).not.toMatch(/regionlabel/i);
      expect(billingZoneRhs).not.toBe(`\${${regionAccessor}}`);
    }

    // Never the exact same placeholder expression under both keys.
    expect(body.split(`\${${regionAccessor}}`).length - 1).toBeLessThanOrEqual(1);

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(body).not.toMatch(/\$\{[^}]*\$\{/);
  });
});
