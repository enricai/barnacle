import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Pins the 1.12.51 "currency" defect at the generator level: once a field is
 * legitimately sourced from `payload.<field>` by exact-name match on ONE call
 * of a multi-call executeHttp (here, call 1's top-level `currency` key,
 * matched by `applyPayloadKeyValueSubstitutions`), every OTHER call in the
 * same function that re-sends the same-named field must also read it from
 * `payload.<field>` — never from a coincidentally-equal response-produced
 * state var, even when that state var is short enough (< MIN_STATE_VALUE_LENGTH)
 * that it only qualifies via the fold/drill force-include exemption
 * (recon-generate.ts:4174-4176). A short value never enters
 * `payloadAccessorByValue` itself (that map only registers inputBody string
 * leaves >= MIN_STATE_VALUE_LENGTH, recon-generate.ts:5849), so the
 * already-landed `payloadAccessorByValue.has(value)` precedence check in
 * `interpolateStateValues` (recon-generate.ts:5050) never sees this value at
 * all — leaving the KV-pass-only, short-value case unguarded.
 */

const SEARCH_URL = "https://api.example.com/catalog/search/";
const DETAIL_URL = "https://api.example.com/catalog/detail/";
const SUBMIT_URL = "https://api.example.com/catalog/submit/";

// Short enough to bypass MIN_STATE_VALUE_LENGTH (8) — so it can only ever be
// indexed as a producible state var via the fold/drill force-include
// exemption, never on its own merits.
const CURRENCY_VALUE = "usd";

function buildPayloadFieldPriorityCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    // Call 1: top-level "currency" key, matched by name against inputBody by
    // applyPayloadKeyValueSubstitutions — this is the "legitimate payload
    // source" the field must keep winning on every later call too.
    buildCapture({
      url: SEARCH_URL,
      requestPostData: JSON.stringify({ currency: CURRENCY_VALUE }),
      responseBody: { sku: "sku-a" },
      timestamp: "2024-09-01T00:00:00Z",
    }),
    // Intervening call: the same short value is coincidentally reproduced at
    // a nested path (meta.currency) — the scraped occurrence this bug
    // wrongly lets win over payload on later calls. Deliberately NOT an
    // array-of-objects primary here: this isolates the plain
    // interpolateStateValues state-var-vs-payload precedence question from
    // `detectDrillDownFoldPlan`'s structural per-item fold/drill loop
    // machinery (a different code path, covered by the sibling fold-loop
    // guard tests) — eligibility is supplied directly below instead.
    buildCapture({
      url: DETAIL_URL,
      requestPostData: JSON.stringify({ sku: "sku-a" }),
      responseBody: { sku: "sku-a", meta: { currency: CURRENCY_VALUE } },
      timestamp: "2024-09-01T00:00:01Z",
    }),
    // Call 3: re-sends "currency" under the same key — must still read
    // ${payload.currency}, never the scraped meta.currency accessor.
    buildCapture({
      url: SUBMIT_URL,
      requestPostData: JSON.stringify({ sku: "sku-a", currency: CURRENCY_VALUE }),
      responseBody: { ok: true },
      timestamp: "2024-09-01T00:00:02Z",
    }),
  ];
}

describe("recon-generate emitMultiStepExecuteHttp — payload field priority across every call", () => {
  it("sources a payload-matched field from payload.<field> on EVERY call, never from a coincidentally-equal fold/drill-exempt short scraped value", () => {
    const captures = buildPayloadFieldPriorityCaptures();
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    // The short value only qualifies for state-var indexing via the
    // fold/drill force-include exemption — supplied directly here (as
    // `collectDependentDrillDownChainValues` would for a genuine structural
    // fold/drill plan) so this unit test isolates the payload-precedence
    // question from fold-plan detection itself.
    const stateIndex = indexStateValues(
      captures,
      new Set(),
      new Set(),
      new Map([[CURRENCY_VALUE, new Set([captures[2]!])]])
    );
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

    const currencyOccurrences = [...body.matchAll(/"currency"\s*:\s*"?([^,\n}]*)"?/g)];
    expect(currencyOccurrences.length).toBeGreaterThanOrEqual(2);
    for (const match of currencyOccurrences) {
      expect(match[1], body).toContain("payload.currency");
    }

    // Never sourced from the coincidentally-equal scraped meta.currency
    // accessor on any call.
    expect(body).not.toMatch(/"currency"\s*:\s*"?\$\{[^}]*meta[^}]*\}/i);

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(body).not.toMatch(/\$\{[^}]*\$\{/);
  });
});
