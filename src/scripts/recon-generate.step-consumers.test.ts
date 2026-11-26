import { describe, expect, it } from "vitest";
import {
  actionSequenceIsReadSamplesFor,
  classifySubmissionFlow,
  compileActionSteps,
  emitBrowserFlowTs,
  extractActionSequence,
  indexStateValues,
  stepFeedsDeclaredSubmit,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const TOKEN = "tok_Zk9qXv81T3mWb7LpR2dYc5Hn";
const TOKEN2 = "hdr_Qq8wXv81T3mWb7LpR2dYc5Hn";

function build() {
  const caps = [
    buildCapture({
      url: "https://a.example.com/mint",
      requestPostData: JSON.stringify({ a: 1 }),
      responseBody: { token: TOKEN },
      timestamp: "2024-01-01T00:00:01Z",
    }),
    buildCapture({
      url: "https://a.example.com/relay",
      requestPostData: JSON.stringify({ token: TOKEN }),
      responseBody: { next: TOKEN2 },
      timestamp: "2024-01-01T00:00:02Z",
    }),
    buildCapture({
      url: "https://a.example.com/submit",
      requestPostData: JSON.stringify({ x: 1 }),
      requestHeaders: { "X-Next": TOKEN2 },
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:03Z",
    }),
    buildCapture({
      url: "https://a.example.com/beacon",
      requestPostData: JSON.stringify({ b: 1 }),
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:04Z",
    }),
  ];
  const seq = extractActionSequence(caps);
  const idx = new Set(seq.map((a) => a.index));
  const steps = compileActionSteps(seq, indexStateValues(caps, new Set(), idx));
  return { caps, steps };
}

describe("step consumers and declared-submit feed", () => {
  it("records consumers and follows them transitively", () => {
    const { caps, steps } = build();
    const [mint, relay, submit, beacon] = caps;
    const isSubmit = (c: unknown) => c === submit;
    const by = (c: unknown) => steps.find((s) => s.capture === c);
    expect(by(mint)?.consumers).toContain(relay);
    expect(by(relay)?.consumers).toContain(submit);
    expect(stepFeedsDeclaredSubmit(relay!, steps, isSubmit)).toBe(true);
    expect(stepFeedsDeclaredSubmit(mint!, steps, isSubmit)).toBe(true);
    expect(stepFeedsDeclaredSubmit(beacon!, steps, isSubmit)).toBe(false);
    expect(stepFeedsDeclaredSubmit(mint!, steps, () => false)).toBe(false);
  });
});

describe("compileActionSteps produces for each origin kind", () => {
  const T1 = "Aq8wXv81T3mWb7LpR2dYc5Hn";
  const T2 = "Bq8wXv81T3mWb7LpR2dYc5Hn";
  const T3 = "Cq8wXv81T3mWb7LpR2dYc5Hn";
  const compile = (caps: ReturnType<typeof buildCapture>[]) => {
    const seq = extractActionSequence(caps);
    const idx = new Set(seq.map((a) => a.index));
    return compileActionSteps(seq, indexStateValues(caps, new Set(), idx));
  };

  it("produces cookie, header and html bindings and records URL/raw-body consumers", () => {
    const caps = [
      buildCapture({
        url: "https://a.example.com/page",
        method: "GET",
        requestPostData: null,
        responseBody: `<html><form action="/go?csrf=${T3}"></form></html>`,
        responseHeaders: {
          "content-type": "text/html",
          "set-cookie": `sid=${T1}; Path=/`,
          "x-price-token": T2,
        },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      buildCapture({
        url: `https://a.example.com/go?csrf=${T3}`,
        requestPostData: `raw=${T1}&t=${T2}`,
        requestHeaders: {
          "Content-Type": "text/plain",
          "X-Price": T2,
          "X-Sid": T1,
        },
        responseBody: { ok: true },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    const steps = compile(caps);
    const first = steps.find((s) => s.capture === caps[0]);
    const kinds = (first?.produces ?? []).map((p) => `${p.kind}`);
    expect(kinds.filter((k) => k === "header").length).toBeGreaterThanOrEqual(2);
    expect(kinds).toContain("html");
    expect(first?.consumers).toContain(caps[1]);
  });
});

describe("read-only GET classification inputs: incidental mint GET and beacon POST", () => {
  // A GET mint hands its token over as a cookie (GET bodies only index UUIDs).
  const MINT_TOKEN = "Zk9qXv81T3mWb7LpR2dYc5Hn";
  const BEACON_TOKEN = "bcn_Qq8wXv81T3mWb7LpR2dYc5Hn";
  const isDeclaredRead = (c: { url: string }) => c.url.includes("/items/search");

  function steps(readSendsMint: boolean) {
    const mint = buildCapture({
      url: "https://shop.example.test/session/token",
      requestPostData: null,
      method: "GET",
      responseBody: {},
      responseHeaders: { "set-cookie": `sid=${MINT_TOKEN}; Path=/` },
      timestamp: "2024-01-01T00:00:01Z",
    });
    const beacon = buildCapture({
      url: "https://shop.example.test/analytics/beacon",
      requestPostData: JSON.stringify({ b: 1 }),
      requestHeaders: { Cookie: `sid=${MINT_TOKEN}` },
      responseBody: { seq: BEACON_TOKEN },
      timestamp: "2024-01-01T00:00:02Z",
    });
    const events = buildCapture({
      url: "https://shop.example.test/analytics/events",
      requestPostData: JSON.stringify({ seq: BEACON_TOKEN }),
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:03Z",
    });
    const read = buildCapture({
      url: "https://shop.example.test/items/search?q=widgets",
      requestPostData: null,
      method: "GET",
      requestHeaders: readSendsMint
        ? { Cookie: `sid=${MINT_TOKEN}` }
        : { Accept: "application/json" },
      responseBody: { items: [1, 2, 3] },
      timestamp: "2024-01-01T00:00:04Z",
    });
    const caps = [mint, beacon, events, read];
    const seq = caps.map((capture, index) => ({ capture, index }));
    const idx = new Set(seq.map((a) => a.index));
    return {
      mint,
      beacon,
      events,
      read,
      steps: compileActionSteps(seq, indexStateValues(caps, new Set(), idx)),
    };
  }

  it("mint GET and beacon POST that feed only each other never feed the declared read", () => {
    const f = steps(false);
    for (const c of [f.mint, f.beacon, f.events]) {
      expect(stepFeedsDeclaredSubmit(c, f.steps, isDeclaredRead)).toBe(false);
    }
    expect(stepFeedsDeclaredSubmit(f.mint, f.steps, (c) => c === f.events)).toBe(true);
  });

  it("a mint GET whose token the declared read re-sends stays a step", () => {
    const f = steps(true);
    expect(stepFeedsDeclaredSubmit(f.mint, f.steps, isDeclaredRead)).toBe(true);
  });

  const classify = (readSendsMint: boolean) => {
    const f = steps(readSendsMint);
    return actionSequenceIsReadSamplesFor({
      compiledActionSteps: f.steps,
      actionCaptures: f.steps.map((s) => ({ capture: s.capture })),
      readSiblings: [f.read],
      declaresSubmitPattern: true,
      matchesDeclaredSubmit: isDeclaredRead,
      isRecurringReadFlowBeacon: () => false,
      isDeclaredDrillCapture: () => false,
    });
  };

  it("incidental mint GET and beacon POST leave the sequence a read", () => {
    expect(classify(false)).toBe(true);
  });

  it("a mint GET the declared read re-sends is still a read flow", () => {
    expect(classify(true)).toBe(true);
  });

  const classifyNoPattern = (matches: (c: { url: string }) => boolean) => {
    const f = steps(true);
    const caps = [f.mint, f.read];
    const seq = caps.map((capture, index) => ({ capture, index }));
    const compiled = compileActionSteps(
      seq,
      indexStateValues(caps, new Set(), new Set(seq.map((a) => a.index)))
    );
    return actionSequenceIsReadSamplesFor({
      compiledActionSteps: compiled,
      actionCaptures: caps.map((capture) => ({ capture })),
      readSiblings: [],
      declaresSubmitPattern: false,
      matchesDeclaredSubmit: matches,
      isRecurringReadFlowBeacon: () => false,
      isDeclaredDrillCapture: () => false,
    });
  };

  it("a mint GET whose only consumer is the declared 2xx GET read stays a read sample", () => {
    expect(classifyNoPattern(isDeclaredRead)).toBe(true);
  });

  it("a mint GET feeding a declared write is not a read sample", () => {
    expect(classifyNoPattern((c) => c.url.includes("/session/token"))).toBe(false);
  });
});

describe("mint GET then declared GET read: classification and browser flow", () => {
  const MINT = "Zk9qXv81T3mWb7LpR2dYc5Hn";
  const isRead = (c: { url: string }) => c.url.includes("/schedule/items.json");
  const mint = buildCapture({
    url: "https://shop.example.test/schedule/start",
    requestPostData: null,
    method: "GET",
    responseBody: {},
    responseHeaders: { "set-cookie": `sid=${MINT}; Path=/` },
    timestamp: "2024-01-01T00:00:01Z",
  });
  const read = buildCapture({
    url: "https://shop.example.test/schedule/items.json?from=a&to=b",
    requestPostData: null,
    method: "GET",
    requestHeaders: { Cookie: `sid=${MINT}` },
    responseBody: { items: [1, 2] },
    timestamp: "2024-01-01T00:00:04Z",
  });
  const post = buildCapture({
    url: "https://shop.example.test/analytics/ping",
    requestPostData: JSON.stringify({ b: 1 }),
    responseBody: { ok: true },
    timestamp: "2024-01-01T00:00:02Z",
  });

  const run = (caps: ReturnType<typeof buildCapture>[]) => {
    const seq = caps.map((capture, index) => ({ capture, index }));
    const steps = compileActionSteps(
      seq,
      indexStateValues(caps, new Set(), new Set(seq.map((a) => a.index)))
    );
    const isReadFlow = actionSequenceIsReadSamplesFor({
      compiledActionSteps: steps,
      actionCaptures: caps.map((capture) => ({ capture })),
      readSiblings: [read],
      declaresSubmitPattern: true,
      matchesDeclaredSubmit: isRead,
      isRecurringReadFlowBeacon: () => false,
      isDeclaredDrillCapture: () => false,
    });
    const submission = classifySubmissionFlow({
      noReplayableActionFlow: false,
      isReadOnlyGetFlow: isReadFlow,
      actionStepCount: steps.length,
      gql: false,
      actionCaptureMethods: caps.map((c) => c.method),
      graphqlActionSequenceHasMutation: false,
    });
    return { isReadFlow, submission };
  };

  it("is a read flow, not a submission, with and without analytics POSTs", () => {
    expect(run([mint, read])).toEqual({ isReadFlow: true, submission: false });
    expect(run([mint, post, read])).toEqual({ isReadFlow: true, submission: false });
  });

  it("a mint feeding a declared POST submit is not a read", () => {
    const submit = buildCapture({
      url: "https://shop.example.test/schedule/book",
      requestPostData: JSON.stringify({ x: 1 }),
      requestHeaders: { Cookie: `sid=${MINT}` },
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:05Z",
    });
    const caps = [mint, submit];
    const seq = caps.map((capture, index) => ({ capture, index }));
    const steps = compileActionSteps(
      seq,
      indexStateValues(caps, new Set(), new Set(seq.map((a) => a.index)))
    );
    expect(
      actionSequenceIsReadSamplesFor({
        compiledActionSteps: steps,
        actionCaptures: caps.map((capture) => ({ capture })),
        readSiblings: [],
        declaresSubmitPattern: true,
        matchesDeclaredSubmit: (c) => c.url.includes("/schedule/book"),
        isRecurringReadFlowBeacon: () => false,
        isDeclaredDrillCapture: () => false,
      })
    ).toBe(false);
  });

  it("emits the GET input fields in the browser flow, never payload.query", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "shop-fixture",
      pascal: "ShopFixture",
      baseUrl: "https://shop.example.test",
      flowSteps: [
        {
          step: "Open the schedule",
          navigateTo: "https://shop.example.test/schedule#/from/a/to/b",
          payloadField: "from",
        },
      ],
      isSubmissionFlow: false,
      readOnlyGetFlow: true,
      getInputFields: ["from", "to"],
    });
    expect(code).toContain("payload.from");
    expect(code).not.toContain("payload.query");
  });
});
