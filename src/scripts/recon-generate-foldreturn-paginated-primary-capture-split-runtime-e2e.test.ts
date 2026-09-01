import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallSingleShotSearchDrillDownNestedJoinFieldPaginatedPrimaryCaptureSplitActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const ENTRY_LOOKUP_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/entry-lookup",
  resultsPath: "items.*.entries",
  drillResultsPath: "entries",
  joinFields: ["id"],
};

function jsonResponse(body: unknown): {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  headers: Headers;
} {
  return {
    status: 200,
    ok: true,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    headers: new Headers(),
  };
}

/** Stubs `fetch` for both re-issued captures of the paginated `/catalog/search/`
 * primary (page 1 and page 2, per the fixture's own request bodies) and the
 * single `/catalog/entry-lookup` drill-down call, whose response carries a
 * `flagged` decoy field alongside the real `id` join field. */
function stubPaginatedPrimaryFetch(): void {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/catalog/entry-lookup")) {
      return jsonResponse({
        entries: [
          { id: "decoy", flagged: true },
          { id: "e1", flagged: true },
        ],
      });
    }
    const requestBody = JSON.parse((init?.body as string | undefined) ?? "{}") as {
      page?: number;
    };
    if (requestBody.page === 1) {
      return jsonResponse({
        items: [{ itemId: "p0", flagged: true, entries: [{ id: "e-shallow", region: "north" }] }],
      });
    }
    return jsonResponse({
      items: [{ itemId: "p1", flagged: false, entries: [{ id: "e1", region: "south" }] }],
    });
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate foldReturn onto a nested array whose primary op was captured twice (paginated) — generated-and-run runtime guard", () => {
  it("folds the declared id join at the nested entries[] level using the spec plan anchored on the second capture, never the boolean-keyed structural plan anchored on the first", async () => {
    const actionSteps =
      buildMulticallSingleShotSearchDrillDownNestedJoinFieldPaginatedPrimaryCaptureSplitActionSteps();
    const inputBody = JSON.parse(actionSteps[0]!.capture.requestPostData ?? "null") as unknown;

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
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      ENTRY_LOOKUP_SPEC
    );

    // Exactly one fold-loop block — the discarded-spec bug duplicated it.
    // resultsPath crosses a wildcard ("items.*.entries"), so the fold-merge
    // loop is a nested `for` over each group's entries, not a flattened
    // `foldItems` — see pathToFoldLoopLines's docstring.
    const foldLoopOccurrences = body.match(/for \(const item of g0\.entries\)/g) ?? [];
    expect(foldLoopOccurrences).toHaveLength(1);

    // The fold match must key on the declared `id` join field, never on the
    // decoy `flagged` field the boolean-keyed structural plan would have used.
    const foldMatchLine = body.split("\n").find((line) => line.includes("foldMatches.find("));
    expect(foldMatchLine).toBeDefined();
    expect(foldMatchLine).toContain('m["id"]');
    expect(foldMatchLine).not.toContain("flagged");

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubPaginatedPrimaryFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({
      BaseUrl: "https://api.example.com",
      page: 1,
      flagged: false,
    });

    // The fold merges onto the nested `entries[]` item (`id: "e1"`), never
    // `Object.assign`ed as booleans onto the outer `items[]` level.
    expect(result.data).toEqual({
      items: [
        {
          itemId: "p1",
          flagged: false,
          entries: [{ id: "e1", region: "south", flagged: true }],
        },
      ],
    });

    // Two primary search calls (page 1, page 2) plus one drill-down call —
    // the fold loop must not have re-issued the drill call more than once
    // per fold item.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(3);
  });
});
