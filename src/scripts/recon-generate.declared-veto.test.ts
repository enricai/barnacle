import { describe, expect, it } from "vitest";
import {
  extractActionSequence,
  extractGraphQLActionSequence,
  resolveFoldPlan,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

function read(ts: string, operationName: string, body: unknown): Capture {
  return {
    timestamp: ts,
    phase: "action",
    method: "POST",
    url: "https://api.example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ operationName }),
    responseHeaders: {},
    operationName: null,
    query: `query { ${operationName} }`,
    variables: null,
    responseBody: body,
    decodedParams: null,
  };
}

describe("declared selection is honored before the zero-variance veto", () => {
  it("keeps declared repeated same-URL reads instead of selecting 0", () => {
    const same = {};
    const caps = [
      read("2026-01-01T00:00:00.000Z", "listRoomOptions", same),
      read("2026-01-01T00:00:01.000Z", "listRoomOptions", same),
      read("2026-01-01T00:00:02.000Z", "listRoomOptions", same),
    ];
    const kept = extractGraphQLActionSequence(
      caps,
      { endpoint: null, body: "listTrips|listRoomOptions" },
      { endpointPattern: "/graphql", resultsPath: "data.items", joinFields: ["id"] }
    );
    expect(kept.length).toBe(3);
  });
});

function post(ts: string, url: string, body: string): Capture {
  return { ...read(ts, "x", {}), url, requestPostData: body, query: null };
}

describe("zero-variance veto still applies to undeclared captures", () => {
  it("graphql: undeclared identical repeats are vetoed", () => {
    const same = {};
    const caps = [
      read("2026-01-01T00:00:00.000Z", "chrome", same),
      read("2026-01-01T00:00:01.000Z", "chrome", same),
      read("2026-01-01T00:00:02.000Z", "chrome", same),
      read("2026-01-01T00:00:03.000Z", "submitIt", { ok: 1 }),
    ];
    const kept = extractGraphQLActionSequence(
      caps,
      { endpoint: null, body: "submitIt" },
      { endpointPattern: "/graphql", resultsPath: "data.items", joinFields: ["id"] }
    );
    expect(JSON.stringify(kept).includes("chrome")).toBe(false);
  });

  it("rest: declared repeated submit kept; undeclared repeats vetoed", () => {
    const u = "https://api.example.com/v1/chrome";
    const s = "https://api.example.com/v1/book";
    const mk = (ts: string, url: string) => post(ts, url, "{}");
    const caps = [
      mk("2026-01-01T00:00:00.000Z", u),
      mk("2026-01-01T00:00:01.000Z", u),
      mk("2026-01-01T00:00:02.000Z", s),
      mk("2026-01-01T00:00:03.000Z", s),
    ];
    const kept = extractActionSequence(caps, { endpoint: "/v1/book", body: null }, null, [
      "api.example.com",
    ]);

    expect(JSON.stringify(kept).includes("/v1/book")).toBe(true);
    expect(JSON.stringify(kept).includes("/v1/chrome")).toBe(false);
  });
});

describe("anonymous search and once-fired drill survive the veto with the search as primary", () => {
  const ANON = "query ($input: ItemsInput!) { allItems(input: $input) { itemId } }";
  const DRILL = "query ItemDetail($itemId: ID!) { itemDetail(id: $itemId) { itemId } }";
  const mk = (ts: string, query: string, variables: unknown, name: string | null, body: unknown) =>
    ({
      ...read(ts, "x", body),
      requestPostData: JSON.stringify({ operationName: name, query, variables }),
      operationName: name,
      query,
      variables,
    }) as Capture;

  it("keeps both, drops chrome, and folds the drill onto the search", () => {
    const rows = { data: { allItems: [{ itemId: "item-aaa-111" }, { itemId: "item-bbb-222" }] } };
    const caps = [
      mk("2026-01-01T00:00:00.000Z", "query Nav { menu { id } }", {}, "Nav", {}),
      mk("2026-01-01T00:00:01.000Z", "query Nav { menu { id } }", {}, "Nav", {}),
      mk("2026-01-01T00:00:02.000Z", "query Nav { menu { id } }", {}, "Nav", {}),
      mk("2026-01-01T00:00:04.000Z", ANON, { input: { currency: "USD" } }, null, rows),
      mk("2026-01-01T00:00:05.000Z", ANON, { input: { currency: "GBP" } }, null, rows),
      mk("2026-01-01T00:00:06.000Z", DRILL, { itemId: "item-bbb-222" }, "ItemDetail", {
        data: { itemDetail: { itemId: "item-bbb-222" } },
      }),
    ];
    const kept = extractGraphQLActionSequence(
      caps,
      { endpoint: null, body: "allItems|itemDetail" },
      { endpointPattern: "/graphql", resultsPath: "data.allItems", joinFields: ["itemId"] }
    );
    const queries = kept.map((a) => a.capture.query);
    expect(queries).toContain(DRILL);
    expect(queries.filter((q) => q === ANON)).toHaveLength(2);
    expect(queries.some((q) => q?.includes("Nav"))).toBe(false);
    const plans = resolveFoldPlan(kept, null, "/graphql::allItems");
    expect(plans).toHaveLength(1);
    expect(kept[plans[0]!.primaryStepIndex]!.capture.query).toBe(ANON);
    expect(kept[plans[0]!.targets[0]!.drillStepIndex]!.capture.query).toBe(DRILL);
  });
});
