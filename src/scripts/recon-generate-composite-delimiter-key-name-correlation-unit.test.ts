import { describe, expect, it } from "vitest";
import { compileActionSteps, indexStateValues } from "@/scripts/recon-generate";

/**
 * Pins `compileActionSteps`' name-correlation gate (recon-generate.ts
 * ~4589-4599) at the function level: a composite, delimiter-bearing response
 * key (e.g. `"DD-INSIDE;entityType=stateroom-type;destination=dcl"`) must
 * NOT be misclassified by `ARRAY_INDEX_KEY_PATTERN` as a name-free,
 * array-index-like source — that pattern only matches all-digit keys, so a
 * key carrying `;`/`=` characters must always fall through to the
 * `keyNamesCorrelate` branch. If the pattern ever regressed to accept such a
 * key, the value below would splice into ANY later body leaf regardless of
 * the target field's name, which is exactly the false-positive-threading bug
 * this net exists to catch.
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
const COMPOSITE_KEY = "DD-INSIDE;entityType=stateroom-type;destination=dcl";
const LEAF_VALUE = "COMPOSITE-VALUE-99182736";

function compile(captures: RawCapture[]): ReturnType<typeof compileActionSteps> {
  const actionCaptures = captures.map((c, index) => ({ capture: c, index }));
  const stateIndex = indexStateValues(captures as never);
  return compileActionSteps(actionCaptures as never, stateIndex);
}

describe("compileActionSteps — composite delimiter-bearing key name correlation", () => {
  it("does NOT produce the value when the later capture's target key does not name-correlate with the composite source key", () => {
    // The composite key contains `;`/`=` characters, so it can never match
    // ARRAY_INDEX_KEY_PATTERN (`/^\d+$/`) and must be routed through the
    // keyNamesCorrelate branch rather than exempted as name-free. The later
    // body re-sends the same literal under an UNRELATED key name, so the
    // correlation must fail and the value must not be threaded.
    const captures = [
      capture({
        url: ENTRY_URL,
        requestPostData: null,
        responseBody: { [COMPOSITE_KEY]: LEAF_VALUE },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: DRILL_URL,
        requestPostData: JSON.stringify({ unrelatedField: LEAF_VALUE }),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    const steps = compile(captures);
    expect(steps[0]?.produces).toHaveLength(0);
  });

  it("DOES produce the value when the later capture's target key name-correlates with the composite source key", () => {
    // Same composite key on both sides — keyNamesCorrelate trivially matches
    // on exact equality, confirming the correlation branch (not the
    // array-index exemption) is what's driving the match.
    const captures = [
      capture({
        url: ENTRY_URL,
        requestPostData: null,
        responseBody: { [COMPOSITE_KEY]: LEAF_VALUE },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: DRILL_URL,
        requestPostData: JSON.stringify({ [COMPOSITE_KEY]: LEAF_VALUE }),
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    const steps = compile(captures);
    expect(steps[0]?.produces).toHaveLength(1);
    const produce = steps[0]?.produces[0];
    expect(produce?.kind).toBe("body");
    expect(produce?.kind === "body" ? produce.path : undefined).toEqual([COMPOSITE_KEY]);
  });
});
