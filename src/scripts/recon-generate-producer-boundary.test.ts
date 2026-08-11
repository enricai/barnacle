import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  deriveProducerBoundaryBindings,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";

/**
 * Locks the producer-boundary binding: a coordinate a step's response produces
 * (and later steps thread as `${var}`) that ALSO rides that same step's own
 * request body must bind to the caller's payload, not stay a frozen capture
 * literal. Without it the producing step ships the recon persona's coordinate
 * (the one job/order recon opened) to every caller, and the downstream steps
 * faithfully thread the echo — the exact wrong-target defect this fixes.
 *
 * Built through the real `indexStateValues` → `compileActionSteps` chain so the
 * `produces[]` entries are the production article, not hand-authored — a drift
 * in how produces are shaped fails here rather than passing a stubbed fixture.
 * Values are ≥8 chars (the state-value floor) and site-neutral.
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

function bindingsFor(captures: RawCapture[]): ReturnType<typeof deriveProducerBoundaryBindings> {
  const actionCaptures = captures.map((c, index) => ({ capture: c, index }));
  const stateIndex = indexStateValues(captures as never);
  const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);
  return deriveProducerBoundaryBindings(actionSteps, new Map());
}

const SUBMIT_URL = "https://api.example.com/submit";

describe("deriveProducerBoundaryBindings", () => {
  it("binds a coordinate the producing step both sends and echoes, re-consumed downstream", () => {
    // Step 0 sends orderRef in its body AND echoes it in its response; step 1
    // re-sends the echoed value → it's a produced state var whose producer is
    // step 0. Step 0 (the producer) must source orderRef from payload.
    const captures = [
      capture({
        url: SUBMIT_URL,
        requestPostData: '{"orderRef":"REF-10025518","stepNum":"one"}',
        responseBody: { result: { orderRef: "REF-10025518" } },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: SUBMIT_URL,
        requestPostData: '{"orderRef":"REF-10025518","stepNum":"two"}',
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    const bindings = bindingsFor(captures);
    expect(bindings.get("REF-10025518")).toEqual({
      accessor: "payload.orderRef",
      field: "orderRef",
      producerIndex: 0,
    });
  });

  it("binds a human-string coordinate absent from any URL", () => {
    // A composite caller string (never a query param) that the producer echoes
    // and a later step threads still binds — the case entry-URL params can't reach.
    const captures = [
      capture({
        url: SUBMIT_URL,
        requestPostData: '{"itemTitle":"Wireless Noise-Cancelling Headphones","stepNum":"one"}',
        responseBody: { result: { itemTitle: "Wireless Noise-Cancelling Headphones" } },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: SUBMIT_URL,
        requestPostData: '{"itemTitle":"Wireless Noise-Cancelling Headphones","stepNum":"two"}',
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    const bindings = bindingsFor(captures);
    expect(bindings.get("Wireless Noise-Cancelling Headphones")).toEqual({
      accessor: "payload.itemTitle",
      field: "itemTitle",
      producerIndex: 0,
    });
  });

  function stepsFor(captures: RawCapture[]): Parameters<typeof deriveProducerBoundaryBindings>[0] {
    const actionCaptures = captures.map((c, index) => ({ capture: c, index }));
    const stateIndex = indexStateValues(captures as never);
    return compileActionSteps(actionCaptures as never, stateIndex) as unknown as Parameters<
      typeof deriveProducerBoundaryBindings
    >[0];
  }

  const echoedRefCaptures = [
    capture({
      url: SUBMIT_URL,
      requestPostData: '{"orderRef":"REF-10025518","stepNum":"one"}',
      responseBody: { result: { orderRef: "REF-10025518" } },
      timestamp: "2024-01-01T00:00:00Z",
    }),
    capture({
      url: SUBMIT_URL,
      requestPostData: '{"orderRef":"REF-10025518","stepNum":"two"}',
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:01Z",
    }),
  ];

  it("reuses a higher-priority payload accessor (e.g. an entry-URL param) for the whole value", () => {
    // A coordinate an entry-URL param already maps to payload.orderRef is bound
    // here too — so the producer step's whole-value slot binds atomically before
    // state threading can fragment a composite. The reused accessor wins.
    const bindings = deriveProducerBoundaryBindings(
      stepsFor(echoedRefCaptures),
      new Map([["REF-10025518", "payload.orderRef"]])
    );
    expect(bindings.get("REF-10025518")).toEqual({
      accessor: "payload.orderRef",
      field: "orderRef",
      producerIndex: 0,
    });
  });

  it("vetoes a value already mapped to a non-payload target (a threaded txn id)", () => {
    const bindings = deriveProducerBoundaryBindings(
      stepsFor(echoedRefCaptures),
      new Map([["REF-10025518", "txnId"]])
    );
    expect(bindings.has("REF-10025518")).toBe(false);
  });

  it("does not bind a produced value that is NOT re-sent in its own producer body", () => {
    // The value is produced by step 0's response and consumed by step 1, but
    // step 0's REQUEST body never carried it → no producer-boundary defect; the
    // ordinary state-threading already handles step 1, and step 0 has nothing to bind.
    const captures = [
      capture({
        url: SUBMIT_URL,
        requestPostData: '{"stepNum":"one"}',
        responseBody: { result: { token: "TOKEN-88817263" } },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: SUBMIT_URL,
        requestPostData: '{"token":"TOKEN-88817263","stepNum":"two"}',
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    const bindings = bindingsFor(captures);
    expect(bindings.has("TOKEN-88817263")).toBe(false);
  });

  it("ignores values below the state-value length floor", () => {
    const captures = [
      capture({
        url: SUBMIT_URL,
        requestPostData: '{"code":"AB12","stepNum":"one"}',
        responseBody: { result: { code: "AB12" } },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: SUBMIT_URL,
        requestPostData: '{"code":"AB12","stepNum":"two"}',
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    expect(bindingsFor(captures).has("AB12")).toBe(false);
  });

  it("does not bind a coordinate whose produce path yields the meaningless 'value' field name", () => {
    // The value sits at an all-numeric response path (`[["…"]]` → path ["0","0"]),
    // so pathToVarName returns its "value" sentinel. Binding it would emit a
    // meaningless `payload.value` schema field; instead it's left to freeze and
    // surface via the unbound-literal TODO for the author to name.
    const captures = [
      capture({
        url: SUBMIT_URL,
        requestPostData: '{"itemRef":"VALUENOKEY123","stepNum":"one"}',
        responseBody: [["VALUENOKEY123"]],
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: SUBMIT_URL,
        requestPostData: '{"itemRef":"VALUENOKEY123","stepNum":"two"}',
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    const bindings = bindingsFor(captures);
    expect(bindings.has("VALUENOKEY123")).toBe(false);
  });
});

describe("emitMultiStepExecuteHttp — producer-boundary integration", () => {
  function emit(
    captures: RawCapture[],
    outFields: Set<string>,
    entryUrlParams: Map<string, string> = new Map()
  ): string {
    const actionCaptures = captures.map((c, index) => ({ capture: c, index }));
    const stateIndex = indexStateValues(captures as never);
    const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);
    return emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      outFields,
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

  it("binds step-1 coordinates to payload and keeps steps 2..N threading the state var", () => {
    // Two coordinates the producer both sends and echoes: a short id and a
    // composite human string whose inner token a genuinely-prior step produces
    // as its own state var (forcing the whole-value pass to run BEFORE state
    // threading, or the leading token strands frozen).
    const captures = [
      // A prior reference call produces "United States" as a threaded label.
      capture({
        url: "https://api.example.com/references",
        requestPostData: '{"kind":"country"}',
        responseBody: { data: { label: "United States" } },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      // Producer: sends orderRef + itemLocation, echoes both in its response.
      capture({
        url: SUBMIT_URL,
        requestPostData:
          '{"orderRef":"REF-10025518","itemLocation":"Austin, United States","stepNum":"one"}',
        responseBody: {
          result: { orderRef: "REF-10025518", itemLocation: "Austin, United States" },
        },
        timestamp: "2024-01-01T00:00:01Z",
      }),
      // Downstream: threads the echoed coordinates.
      capture({
        url: SUBMIT_URL,
        requestPostData:
          '{"orderRef":"REF-10025518","itemLocation":"Austin, United States","stepNum":"two"}',
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:02Z",
      }),
    ];
    const outFields = new Set<string>();
    const body = emit(captures, outFields);

    // The emitted interpolation opener `${`, assembled by concatenation so
    // Biome's noTemplateCurlyInString doesn't flag these assertion strings.
    const I = `$${"{"}`;

    // Step 1 (producer) binds to payload, not the frozen literal.
    expect(body).toContain(`${I}payload.orderRef}`);
    expect(body).toContain(`${I}payload.itemLocation}`);
    expect(body).not.toContain('"orderRef":"REF-10025518"');
    // The composite bound atomically — no leading token stranded next to a state var.
    expect(body).not.toContain(`Austin, ${I}label}`);
    expect(body).not.toContain('"itemLocation":"Austin');
    // The fields are declared in the emitted payload schema.
    expect(outFields.has("orderRef")).toBe(true);
    expect(outFields.has("itemLocation")).toBe(true);
    // The downstream (non-producer) step threads the produced state var, not the
    // payload field — the producer-boundary bind is scoped to the producer alone.
    const downstream = body.slice(body.lastIndexOf("/submit"));
    expect(downstream).toContain(`"orderRef":"${I}orderRef}"`);
    expect(downstream).not.toContain(`"orderRef":"${I}payload.orderRef}"`);
  });

  it("emits unchanged output when no producer-boundary reuse exists", () => {
    // A produced value consumed downstream but NOT re-sent in its own producer
    // body must not gain a spurious payload binding.
    const captures = [
      capture({
        url: SUBMIT_URL,
        requestPostData: '{"stepNum":"one"}',
        responseBody: { result: { token: "TOKEN-88817263" } },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: SUBMIT_URL,
        requestPostData: '{"token":"TOKEN-88817263","stepNum":"two"}',
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    const outFields = new Set<string>();
    const body = emit(captures, outFields);
    expect(body).not.toContain("payload.token");
    expect(outFields.has("token")).toBe(false);
  });

  it("binds an entry-URL coordinate whole on every step, even where a prior state var would fragment it", () => {
    // The entry-URL coordinate PREFIX-A-1002550 is a state value a prior step
    // produces (echoed as `refPrefix`), so a naive length-descending pass would
    // fragment the composite `PREFIX-A-1002550-EXT` into `${refPrefix}-1002550-EXT`
    // and strand the middle frozen. The whole-value entry-URL pass binds the full
    // slot to payload before state threading can split it — on the non-producer
    // step too.
    const I = `$${"{"}`;
    const captures = [
      capture({
        url: "https://api.example.com/refs",
        requestPostData: '{"kind":"prefix"}',
        responseBody: { data: { refPrefix: "PREFIX-A" } },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: SUBMIT_URL,
        requestPostData: '{"listingRef":"PREFIX-A-1002550-EXT","stepNum":"one"}',
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    const outFields = new Set<string>();
    const entryUrlParams = new Map([["PREFIX-A-1002550-EXT", "payload.listingRef"]]);
    const body = emit(captures, outFields, entryUrlParams);
    expect(body).toContain(`"listingRef":"${I}payload.listingRef}"`);
    expect(body).not.toContain("1002550");
  });

  it("declares the payload field for a producer coordinate that also appears embedded (collision-blocked)", () => {
    // ITEMREF10 is a whole leaf on its producer (`"itemRef":"ITEMREF10"`) AND
    // appears embedded, alnum-flanked, in a later step (`"combo":"aITEMREF10b"`),
    // so bindsWithoutCollision() blocks the unanchored registration. The whole-
    // value pass still binds the producer's own slot, so the field MUST be
    // declared — otherwise the emitted `${payload.itemRef}` references a payload
    // property absent from the schema and the generated contract won't typecheck.
    const I = `$${"{"}`;
    const captures = [
      capture({
        url: SUBMIT_URL,
        requestPostData: '{"itemRef":"ITEMREF10","stepNum":"one"}',
        responseBody: { result: { itemRef: "ITEMREF10" } },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: SUBMIT_URL,
        requestPostData: '{"itemRef":"ITEMREF10","combo":"aITEMREF10b","stepNum":"two"}',
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    const outFields = new Set<string>();
    const body = emit(captures, outFields);
    expect(body).toContain(`"itemRef":"${I}payload.itemRef}"`);
    // The invariant: every emitted `${payload.itemRef}` is backed by a declared field.
    expect(outFields.has("itemRef")).toBe(true);
  });

  it("never binds a produced-and-re-sent UUID to a payload field", () => {
    // A client-minted / server-echoed UUID satisfies produced-∩-re-sent, but it is
    // a volatile/threaded id owned by another pass — binding it to payload would
    // freeze the recon's single id into every caller's submission.
    const uuid = "3f4a1b2c-5d6e-4f70-8a91-b2c3d4e5f607";
    const captures = [
      capture({
        url: SUBMIT_URL,
        requestPostData: `{"apTxnId":"${uuid}","stepNum":"one"}`,
        responseBody: { result: { apTxnId: uuid } },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      capture({
        url: SUBMIT_URL,
        requestPostData: `{"apTxnId":"${uuid}","stepNum":"two"}`,
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    expect(bindingsFor(captures).has(uuid)).toBe(false);
    const outFields = new Set<string>();
    const body = emit(captures, outFields);
    expect(body).not.toContain("payload.apTxnId");
    expect(outFields.has("apTxnId")).toBe(false);
  });
});
