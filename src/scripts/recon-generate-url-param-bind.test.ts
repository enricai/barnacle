import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";

/**
 * Locks URL-param binding: a caller coordinate copied into a URL-valued body
 * field's query string (a redirect / thank-you URL) must bind the same way the
 * field's top-level sibling does, instead of shipping the recon persona's frozen
 * coordinate on every request. Covers the three sub-cases the real capture hit:
 * a composite that state-threading would otherwise fragment mid-URL, a
 * double-URL-encoded value that never textually matches a bound value, and a
 * downstream step that threads a produced state var inside the URL.
 *
 * Driven through the real `indexStateValues` → `compileActionSteps` →
 * `emitMultiStepExecuteHttp` chain (the helpers are internal), values ≥8 chars,
 * site-neutral fixtures.
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

const SUBMIT_URL = "https://api.example.com/submit";
const THANKYOU = "https://api.example.com/thankyou";

function emit(captures: RawCapture[], entryUrlParams: Map<string, string> = new Map()): string {
  const actionCaptures = captures.map((c, index) => ({ capture: c, index }));
  const stateIndex = indexStateValues(captures as never);
  const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);
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
    entryUrlParams
  );
}

// The emitted interpolation opener `${`, assembled by concatenation so Biome's
// noTemplateCurlyInString doesn't flag these assertion strings.
const I = `$${"{"}`;

describe("emitMultiStepExecuteHttp — URL-param binding", () => {
  it("binds a composite coordinate WHOLE inside a URL on the producer, even when a prior state var prefixes it", () => {
    // A reference call produces "PFX-9988" — the prefix of the composite seq.
    // Running the URL pass before state threading is what keeps the seq= param
    // from fragmenting into `${refVar}...SUFFIX` and stranding the tail frozen.
    const SEQ = "PFX-998877665500SUFFIX";
    const captures = [
      capture({
        url: "https://api.example.com/references",
        requestPostData: JSON.stringify({ kind: "ref" }),
        responseBody: { data: { ref: "PFX-9988" } },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: SUBMIT_URL,
        requestPostData: JSON.stringify({
          itemSeqNo: SEQ,
          itemId: "77665500",
          redirect: `${THANKYOU}?status=success&seq=${SEQ}&id=77665500`,
        }),
        responseBody: { result: { itemSeqNo: SEQ, itemId: "77665500" } },
        timestamp: "2024-01-01T00:00:01Z",
      }),
      capture({
        url: SUBMIT_URL,
        requestPostData: JSON.stringify({
          itemSeqNo: SEQ,
          itemId: "77665500",
          redirect: `${THANKYOU}?status=success&seq=${SEQ}&id=77665500`,
        }),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:02Z",
      }),
    ];
    const out = emit(captures, new Map([[SEQ, "payload.itemSeqNo"]]));
    expect(out).toContain(`seq=${I}payload.itemSeqNo}`);
    // The raw composite must be gone from every URL query string.
    expect(out).not.toContain(`seq=${SEQ}`);
    // The id threads a state var (or payload) inside the URL — never frozen raw.
    expect(out).toMatch(/id=\$\{(payload\.itemId|itemId2)\}/);
    expect(out).not.toContain("id=77665500");
    // status=success stays byte-identical.
    expect(out).toContain("status=success&");
  });

  it("binds a DOUBLE-encoded param inside a URL by nesting encodeURIComponent twice", () => {
    const RAW = "Senior Widget Engineer";
    const enc2 = encodeURIComponent(encodeURIComponent(RAW));
    const captures = [
      capture({
        url: SUBMIT_URL,
        requestPostData: JSON.stringify({
          itemTitle: RAW,
          redirect: `${THANKYOU}?status=success&title=${enc2}`,
        }),
        responseBody: { result: { itemTitle: RAW } },
        timestamp: "2024-01-01T00:00:01Z",
      }),
      capture({
        url: SUBMIT_URL,
        requestPostData: JSON.stringify({
          itemTitle: RAW,
          redirect: `${THANKYOU}?status=success&title=${enc2}`,
        }),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:02Z",
      }),
    ];
    const out = emit(captures);
    expect(out).toContain(`title=${I}encodeURIComponent(encodeURIComponent(`);
    // No frozen double-encoded literal left anywhere.
    expect(out).not.toContain(enc2);
  });

  it("binds a single-encoded param with one encodeURIComponent and re-declares the wrapped state var", () => {
    // A value the first step produces AND re-sends (so it is a threaded state
    // var) appears inside the URL only as a single-encoded param. Its `const`
    // must still be emitted despite being wrapped in encodeURIComponent — the
    // reference scan has to see through the wrap.
    const LOC = "Austin, United States";
    const enc1 = encodeURIComponent(LOC);
    const captures = [
      capture({
        url: SUBMIT_URL,
        requestPostData: JSON.stringify({ place: LOC, kind: "start" }),
        responseBody: { data: { place: LOC } },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: SUBMIT_URL,
        requestPostData: JSON.stringify({
          place: LOC,
          redirect: `${THANKYOU}?status=success&loc=${enc1}`,
        }),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    const out = emit(captures);
    expect(out).toContain(`loc=${I}encodeURIComponent(place)}`);
    // The wrapped state var must still be declared (scan must see through the wrap).
    expect(out).toMatch(/const place = /);
    expect(out).not.toContain(`loc=${enc1}`);
  });

  it("leaves an unmatched URL param and a cache-buster param byte-identical", () => {
    // No binding provided for any value here, so the URL pass is a pure no-op:
    // the unmatched long value and the `_` cache-buster both stay verbatim.
    const captures = [
      capture({
        url: SUBMIT_URL,
        requestPostData: JSON.stringify({
          redirect: `${THANKYOU}?status=success&_=1786423644996&other=UNMATCHEDLONGVALUE`,
        }),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:00Z",
      }),
    ];
    const out = emit(captures);
    // Host is rewritten to ${payload.BaseUrl} by the existing BaseUrl pass; the
    // query string — including the cache-buster and the unmatched value — is untouched.
    expect(out).toContain("?status=success&_=1786423644996&other=UNMATCHEDLONGVALUE");
  });
});
