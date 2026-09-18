import { describe, expect, it } from "vitest";
import type { AdditionalBodyKeyInfo } from "@/scripts/recon-generate";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";

/**
 * Locks two payload-schema registration gaps in emitMultiStepExecuteHttp: a
 * field the emitted body template references as `${payload.<field>}` must
 * always have a matching `outDiscoveredFields`/`outDiscoveredAdditionalBodyKeys`
 * entry, or the generated contract's payload type won't declare the property
 * the body template reads (TS2339). Both gaps involve the entry/primary
 * action's OWN request body: (a) its string leaves, registered by the
 * `payloadAccessorByValue` walk but never added to `outDiscoveredFields`;
 * (b) its top-level primitive keys, substituted into a later call's body by
 * `applyPayloadKeyValueSubstitutions` but skipped from `outAdditionalKeys`.
 */

interface RawCapture {
  timestamp: string;
  phase: string;
  method: string;
  url: string;
  status: number;
  requestHeaders: Record<string, string>;
  requestPostData: string | null;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  operationName: null;
  query: null;
  variables: null;
  decodedParams: null;
}

function capture(overrides: {
  url: string;
  requestPostData: string | null;
  responseBody: unknown;
  timestamp: string;
}): RawCapture {
  return {
    timestamp: overrides.timestamp,
    phase: "action",
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData,
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const ENTRY_URL = "https://api.example.com/entry";
const DRILL_URL = "https://api.example.com/drill";

function emit(
  captures: RawCapture[],
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

describe("emitMultiStepExecuteHttp — payload schema field registration", () => {
  it("registers a string leaf of the entry body's own request that a later call re-references via payload.<field>", () => {
    // Entry body carries `reference` (≥ MIN_STATE_VALUE_LENGTH). The entry's
    // string leaves get mapped into payloadAccessorByValue and re-used to
    // substitute the SAME literal on a later drill call's body — so the
    // emitted template reads `${payload.reference}` on step 2, and the field
    // MUST be declared on the schema.
    const inputBody = { reference: "ORDER-REFERENCE-99182736" };
    const captures = [
      capture({
        url: ENTRY_URL,
        requestPostData: JSON.stringify(inputBody),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: DRILL_URL,
        requestPostData: JSON.stringify({ lookupRef: "ORDER-REFERENCE-99182736" }),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    const outFields = new Set<string>();
    const outAdditionalBodyKeys = new Map<string, AdditionalBodyKeyInfo>();
    const body = emit(captures, inputBody, outFields, outAdditionalBodyKeys);

    const I = `$${"{"}`;
    expect(body).toContain(`${I}payload.reference}`);
    // The invariant this closes: every emitted payload.<field> accessor is
    // backed by a declared discovered field.
    expect(outFields.has("reference")).toBe(true);
  });

  it("registers the entry body's own top-level key when a later call's body substitutes the same value via payload.<key>", () => {
    // The entry body's own key `category` is re-sent verbatim on a later
    // call's body. applyPayloadKeyValueSubstitutions substitutes that later
    // occurrence to `${payload.category}` regardless of whether `category`
    // is "new" relative to inputBody — the field must be declared or the
    // substitution references an undeclared payload property.
    const inputBody = { category: "outdoor-gear" };
    const captures = [
      capture({
        url: ENTRY_URL,
        requestPostData: JSON.stringify(inputBody),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: DRILL_URL,
        requestPostData: JSON.stringify({ category: "outdoor-gear", page: 2 }),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    const outFields = new Set<string>();
    const outAdditionalBodyKeys = new Map<string, AdditionalBodyKeyInfo>();
    const body = emit(captures, inputBody, outFields, outAdditionalBodyKeys);

    const I = `$${"{"}`;
    expect(body).toContain(`"category":"${I}payload.category}"`);
    expect(outAdditionalBodyKeys.has("category")).toBe(true);
    expect(outAdditionalBodyKeys.get("category")).toEqual({ kind: "string" });
  });

  it("registers a NESTED string leaf of the entry body (e.g. formData.reference) as a flat payload field", () => {
    // The entry body's leaf sits below a nested object, so its JSON path has
    // more than one segment. The registration pass must still declare a
    // field for it — the payload schema is always flat, so the accessor it
    // emits (and the field it registers) must both be a single flattened
    // identifier, never a dotted/bracketed chain into a nonexistent nested
    // shape.
    const inputBody = { formData: { reference: "ORDER-REFERENCE-99182736" } };
    const captures = [
      capture({
        url: ENTRY_URL,
        requestPostData: JSON.stringify(inputBody),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: DRILL_URL,
        requestPostData: JSON.stringify({ lookupRef: "ORDER-REFERENCE-99182736" }),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    const outFields = new Set<string>();
    const outAdditionalBodyKeys = new Map<string, AdditionalBodyKeyInfo>();
    const body = emit(captures, inputBody, outFields, outAdditionalBodyKeys);

    const I = `$${"{"}`;
    expect(body).toContain(`${I}payload.formDataReference}`);
    expect(body).not.toMatch(/\$\{payload\.formData\.reference\}/);
    expect(outFields.has("formDataReference")).toBe(true);
  });

  it("registers the same field name for EVERY step's own occurrence when two non-entry steps reuse a key with different literal values", () => {
    // Two drill calls both send a top-level `region` body key, but with
    // DIFFERENT literal values. A first-seen-value-wins registration table
    // would only ever match (and thus only ever register) the ONE step
    // whose literal happens to equal the first value scanned — leaving the
    // other step's own `${payload.region}` occurrence backed by nothing.
    // Both occurrences must resolve to a payload accessor, and the field
    // must be declared regardless of which step's value was seen first.
    const inputBody = { orderId: "ORDER-REFERENCE-99182736" };
    const captures = [
      capture({
        url: ENTRY_URL,
        requestPostData: JSON.stringify(inputBody),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: DRILL_URL,
        requestPostData: JSON.stringify({ region: "east" }),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
      capture({
        url: DRILL_URL,
        requestPostData: JSON.stringify({ region: "west" }),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:02Z",
      }),
    ];
    const outFields = new Set<string>();
    const outAdditionalBodyKeys = new Map<string, AdditionalBodyKeyInfo>();
    const body = emit(captures, inputBody, outFields, outAdditionalBodyKeys);

    const I = `$${"{"}`;
    // Every emitted `${payload.region}` occurrence — regardless of which
    // step's literal it came from — must be backed by a declared field.
    const payloadReferenceCount = body.split(`${I}payload.region}`).length - 1;
    expect(payloadReferenceCount).toBe(2);
    expect(outAdditionalBodyKeys.has("region")).toBe(true);
    // Both distinct values register as the field's discovered vocabulary —
    // this fixture's own two-step reuse doubles as evidence for the
    // vocabulary-derived z.enum() emission this repo's schema now supports.
    expect(outAdditionalBodyKeys.get("region")).toEqual({
      kind: "string",
      enumValues: ["east", "west"],
    });
  });
});
