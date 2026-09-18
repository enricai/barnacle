import { describe, expect, it } from "vitest";
import type { AdditionalBodyKeyInfo } from "@/scripts/recon-generate";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Sibling of recon-generate-payload-accessor-field-registration.test.ts's
 * registration-discipline tests, routed through the ONE code path those
 * tests never exercise: a `payload.<field>` accessor emitted from WITHIN a
 * fold/drill `Promise.allSettled(...map(...))` loop body
 * (emitMultiStepExecuteHttp's per-item `parameterize` closure at
 * recon-generate.ts:6468, wrapped by the loop construction starting at
 * recon-generate.ts:6341), not the flat sequential path the sibling tests
 * cover. A primary array response is drilled per item; every per-item drill
 * request carries the SAME long-enough-to-bind literal on a field that does
 * not vary with the item (so it is a caller-supplied payload accessor, not
 * a threaded join field) — mirroring the report's `payload.page` /
 * `payload.region` / `payload.storeId` gap class for the loop-emission path.
 */

const LIST_URL = "https://api.example.com/catalog/search/";
const DETAIL_URL = "https://api.example.com/catalog/detail/";

// Long enough to clear MIN_STATE_VALUE_LENGTH and identical across every
// per-item detail capture — a caller-payload field, not an item-varying
// join field.
const REGION_VALUE = "REGION-WEST-DISTRIBUTION-01";

function fixtureCaptures(): Capture[] {
  const listPage = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ resultPage: 1 }),
    responseBody: {
      results: [{ itemId: "item-a" }, { itemId: "item-b" }],
    },
    timestamp: "2026-04-01T00:00:00Z",
  });
  const detailA = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-a", region: REGION_VALUE }),
    responseBody: { storeCode: "store-42" },
    timestamp: "2026-04-01T00:00:01Z",
  });
  const detailB = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-b", region: REGION_VALUE }),
    responseBody: { storeCode: "store-43" },
    timestamp: "2026-04-01T00:00:02Z",
  });
  return [listPage, detailA, detailB];
}

function emit(
  captures: Capture[],
  inputBody: unknown,
  outFields: Set<string>,
  outAdditionalBodyKeys: Map<string, AdditionalBodyKeyInfo>
): string {
  const actionCaptures = captures.map((c, index) => ({ capture: c, index }));
  const stateIndex = indexStateValues(captures as never);
  const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);
  return emitMultiStepExecuteHttp(
    actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
    inputBody,
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    outFields,
    new Map(),
    new Set(),
    new Map(),
    outAdditionalBodyKeys,
    "https://api.example.com",
    new Map(),
    new Map()
  );
}

describe("emitMultiStepExecuteHttp — payload schema field registration inside a fold/drill loop body", () => {
  it("registers a payload.<field> accessor emitted from WITHIN the per-item fold loop body", () => {
    const captures = fixtureCaptures();
    const outFields = new Set<string>();
    const outAdditionalBodyKeys = new Map<string, AdditionalBodyKeyInfo>();
    const body = emit(captures, {}, outFields, outAdditionalBodyKeys);

    // A genuine multi-item fold loop, not a hardcoded per-item call.
    expect(body).toMatch(/Promise\.allSettled\(\s*\(\w+\)\.map\(async \(\w+\) => \{/);

    const I = `$${"{"}`;
    // The fold loop's own per-item detail request splices `region` as a
    // payload accessor INSIDE the loop body.
    expect(body).toContain(`${I}payload.region}`);

    // The invariant this closes for the loop-emission path: every emitted
    // payload.<field> accessor is backed by a declared discovered field.
    expect(outFields.has("region") || outAdditionalBodyKeys.has("region")).toBe(true);
  });
});
