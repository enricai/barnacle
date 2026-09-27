import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Pins the "typed facets never threaded into request bodies" defect: a
 * required scalar (string) schema field IS correctly bound on the ONE call
 * whose body carries it as its own exact top-level `"<field>":<value>` pair
 * (that call already works, via `applyPayloadKeyValueSubstitutions`'s exact
 * key match) — but the SAME captured value, packed inside a LATER call's
 * delimited facet-filter string under a differently-named wire key, was left
 * as a frozen literal instead of being spliced with `${payload.<field>}`,
 * exactly like `renderGqlVariablesExpr`/`spliceFacetsIntoStringVariable`
 * already correlate for the primary GraphQL operation's own variables.
 */

const SEARCH_URL = "https://api.example.com/catalog/search/";
const FILTER_URL = "https://api.example.com/catalog/filter/";

// Deliberately SHORT (< MIN_STATE_VALUE_LENGTH, 8) so the generic
// length-descending value substitution pass (`interpolateStateValues`,
// which would otherwise mask this gap by rewriting ANY sufficiently long
// occurrence of the value regardless of JSON-key context) never binds it —
// isolating the exact-key-only reach of `applyPayloadKeyValueSubstitutions`
// this fix extends.
const REGION_VALUE = "north";

function buildFacetFieldCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    // Call 1: "region" is captured as its own exact top-level key — the
    // already-correct case, wired by applyPayloadKeyValueSubstitutions's
    // exact-key pass.
    buildCapture({
      url: SEARCH_URL,
      requestPostData: JSON.stringify({ region: REGION_VALUE, sku: "sku-a" }),
      responseBody: { sku: "sku-a" },
      timestamp: "2024-09-01T00:00:00Z",
    }),
    // Call 2: a GraphQL-shaped body whose sole top-level key ("variables") is
    // recognized as the form envelope (so it's never wholesale-swallowed by
    // applyStructuredValuePayloadSubstitutions) — but its OWN nested
    // "filters" facet string, one level below that envelope, sits outside
    // applyPayloadKeyValueSubstitutions's exact-top-level-key reach. The
    // captured region value is packed there under a differently-named wire
    // key, not re-sent as its own top-level "region" field — the gap.
    buildCapture({
      url: FILTER_URL,
      requestPostData: JSON.stringify({
        variables: { sku: "sku-a", filters: `region:${REGION_VALUE}|category:widgets` },
      }),
      responseBody: { ok: true },
      timestamp: "2024-09-01T00:00:01Z",
    }),
  ];
}

describe("recon-generate emitMultiStepExecuteHttp — typed scalar facet fields interpolated into every request", () => {
  it("splices a captured scalar facet field into a payload accessor everywhere its value is load-bearing, including inside a differently-keyed facet-filter string on a later call", () => {
    const captures = buildFacetFieldCaptures();
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures, new Set(), new Set(), new Map());
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

    // The captured literal value never survives verbatim anywhere in the
    // rendered request bodies.
    expect(body).not.toContain(REGION_VALUE);

    // ${payload.region} shows up both on the call that captured it as its
    // own top-level key AND spliced into the later call's facet-filter
    // string — not just the first, already-working occurrence.
    const payloadRegionOccurrences = body.match(/\$\{payload\.region\}/g) ?? [];
    expect(payloadRegionOccurrences.length, body).toBeGreaterThanOrEqual(2);

    // The facet-filter string on call 2 threads the splice, keeping its own
    // non-facet segment ("category:widgets") literal.
    expect(body).toMatch(/region:\$\{payload\.region\}/);
    expect(body).toContain("category:widgets");

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(body).not.toMatch(/\$\{[^}]*\$\{/);
  });
});
