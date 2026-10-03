import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression guard for applyPayloadKeyValueSubstitutions's pre-existing
 * scalar-key behaviors — the PAGINATION_FIELD_NAME_PATTERN same-key-
 * different-value exclusion, the (key,value)-pair dedupe, and the
 * vocabulary-derived string-enum inference — alongside a varying top-level
 * array/object field threaded by applyStructuredValuePayloadSubstitutions.
 * Proves the array/object path is additive to the scalar path rather than
 * disruptive, over a corpus mixing a pagination cursor, an ordinary scalar
 * facet, and a varying array field in the same run.
 */

const SEARCH_URL = "https://api.example.com/catalog/search/";

// Long enough to clear MIN_STATE_VALUE_LENGTH (8), so each is a candidate
// for splicing as a payload accessor rather than staying a frozen literal.
const PAGE_ONE_VALUE = "PAGE-TOKEN-ONE-STANDARD-01";
const PAGE_TWO_VALUE = "PAGE-TOKEN-TWO-STANDARD-01";
const CATEGORY_VALUE_A = "CATEGORY-WIDGETS-STANDARD-01";
const CATEGORY_VALUE_B = "CATEGORY-GADGETS-STANDARD-01";

function buildScalarSplicePaginationDedupeCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    // Call 1: page=PAGE_ONE_VALUE, category=CATEGORY_VALUE_A, lineItems varies.
    buildCapture({
      url: SEARCH_URL,
      requestPostData: JSON.stringify({
        page: PAGE_ONE_VALUE,
        category: CATEGORY_VALUE_A,
        lineItems: [{ sku: "sku-a", quantity: 1 }],
      }),
      responseBody: { results: [{ itemId: "item-a" }] },
      timestamp: "2024-09-01T00:00:00Z",
    }),
    // Call 2: same endpoint, page advances (pagination re-query), category
    // takes a DIFFERENT value (closed-set vocabulary facet, 2 distinct
    // values — still within VOCABULARY_ENUM_MAX_DISTINCT_VALUES), lineItems
    // varies again.
    buildCapture({
      url: SEARCH_URL,
      requestPostData: JSON.stringify({
        page: PAGE_TWO_VALUE,
        category: CATEGORY_VALUE_B,
        lineItems: [{ sku: "sku-b", quantity: 2 }],
      }),
      responseBody: { results: [{ itemId: "item-b" }] },
      timestamp: "2024-09-01T00:00:01Z",
    }),
  ];
}

describe("recon-generate emitMultiStepExecuteHttp — scalar splice/pagination/dedupe unchanged alongside array/object threading", () => {
  it("leaves the pagination key's later occurrence literal, splices the scalar facet, infers its vocabulary enum, and additionally splices the array field", () => {
    const captures = buildScalarSplicePaginationDedupeCaptures();
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures, new Set(), new Set(), new Map());
    const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);

    const outDiscoveredAdditionalBodyKeys = new Map();
    const outStructuredKeys = new Map();

    const body = emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      inputBody,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      outDiscoveredAdditionalBodyKeys,
      "https://api.example.com",
      new Map(),
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      outStructuredKeys
    );

    // Pagination key: the FIRST call legitimately sources "page" from
    // payload (it's the input body's own key), but the SECOND call's own
    // literal value stays an unsubstituted literal — unchanged pre-fix
    // behavior (a re-query must advance to the next page, not replay the
    // first page's own accessor).
    const pageOccurrences = [...body.matchAll(/"page"\s*:\s*"?([^,\n}]*)"?/g)];
    expect(pageOccurrences.length).toBe(2);
    expect(pageOccurrences[0]![1]).toContain("payload.page");
    expect(pageOccurrences[1]![1]).toContain(PAGE_TWO_VALUE);
    expect(pageOccurrences[1]![1]).not.toContain("payload.page");

    // Scalar facet: spliced to a single payload.category accessor on both
    // calls, never left as a frozen literal.
    const categoryOccurrences = [...body.matchAll(/"category"\s*:\s*"?([^,\n}]*)"?/g)];
    expect(categoryOccurrences.length).toBeGreaterThanOrEqual(2);
    for (const match of categoryOccurrences) {
      expect(match[1], body).toContain("payload.category");
    }
    expect(body).not.toContain(CATEGORY_VALUE_A);
    expect(body).not.toContain(CATEGORY_VALUE_B);

    // Vocabulary-derived string enum: category's two distinct observed
    // values are both recorded against the discovered key, unchanged by the
    // presence of the array/object field in the same corpus.
    const categoryInfo = outDiscoveredAdditionalBodyKeys.get("category");
    expect(categoryInfo?.kind).toBe("string");
    expect(categoryInfo?.enumValues).toEqual(
      expect.arrayContaining([CATEGORY_VALUE_A, CATEGORY_VALUE_B])
    );

    // Array/object field: additionally declared/spliced in the SAME
    // generated output, proving the array/object path is additive rather
    // than disruptive to the scalar passes above.
    expect(body).toMatch(/payload\.lineItems\b/);
    expect(body).not.toContain(`"sku":"sku-a"`);
    expect(body).not.toContain(`"sku":"sku-b"`);
    expect(outStructuredKeys.has("lineItems")).toBe(true);

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(body).not.toMatch(/\$\{[^}]*\$\{/);
  });
});
