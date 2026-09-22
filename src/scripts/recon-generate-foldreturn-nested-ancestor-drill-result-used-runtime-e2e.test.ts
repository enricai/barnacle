import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  compileActionSteps,
  emitContractTs,
  emitMultiStepExecuteHttp,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";
import {
  evalExecuteHttpBody,
  extractExecuteHttpBodyFromContract,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Functional (not merely static/lint) proof that a two-level nested primary
 * array's per-item httpClient drill call actually flows into the final
 * envelope for every leaf item, closing
 * recon-generate-1.12.63-crash-fixed-but-fold-join-ignores-declared-joinfields-plus-unused-httpclient-result.md's
 * "this is likely losing real data" concern about Finding 2: fetching a
 * drilled response and then discarding it instead of merging it onto the
 * matching leaf item. Each of 3 leaf items, spread across two ancestor
 * groups (so both the group loop and the nested item loop are exercised),
 * gets its own distinct drilled field via its own httpClient POST — the
 * drill param (the item's own `entryId`) varies between siblings in the
 * SAME group, so a correct emission must issue one POST per leaf item, not
 * one per group.
 */

const BASE_URL = "https://api.example.com";
const SECTIONS_URL = `${BASE_URL}/catalog/sections`;
const ENTRY_DETAILS_URL = `${BASE_URL}/catalog/entries/details`;

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/entries/details",
  resultsPath: "sections.*.entries",
  drillResultsPath: "details",
  joinFields: ["entryId"],
};

function fixtureCaptures(): Capture[] {
  const search = buildCapture({
    url: SECTIONS_URL,
    requestPostData: '{"page":1}',
    responseBody: {
      sections: [
        {
          id: "sec1",
          entries: [
            { entryId: "e1", name: "Widget" },
            { entryId: "e2", name: "Gadget" },
          ],
        },
        {
          id: "sec2",
          entries: [{ entryId: "e3", name: "Doohickey" }],
        },
      ],
    },
    timestamp: "2026-01-01T00:00:00Z",
  });
  // Only ONE real drill capture is needed for codegen (it establishes the
  // per-item request template) plus one decoy with foreign values, proving
  // {@link findFrozenVaryingDrillParams}'s variance check has something
  // genuinely differing to compare `entryId`/`groupId` against — the same
  // real/decoy split recon-generate-multicall-fixture.ts's own nested-group
  // drill-down builders use. At RUNTIME, each leaf item's own `entryId`
  // interpolates into its own request (asserted below), so a single
  // generation-time capture is enough to prove the per-item fan-out.
  const detailsE1 = buildCapture({
    url: ENTRY_DETAILS_URL,
    requestPostData: JSON.stringify({ entryId: "e1", groupId: "sec1" }),
    responseBody: { details: [{ entryId: "e1", description: "A widget." }] },
    timestamp: "2026-01-01T00:00:01Z",
  });
  const detailsDecoy = buildCapture({
    url: ENTRY_DETAILS_URL,
    requestPostData: JSON.stringify({ entryId: "zzz-unrelated", groupId: "zzz-unrelated-g" }),
    responseBody: { details: [{ entryId: "zzz-unrelated", description: "An unrelated entry." }] },
    timestamp: "2026-01-01T00:00:02Z",
  });
  return [search, detailsE1, detailsDecoy];
}

function generateContract(): string {
  const captures = fixtureCaptures();
  const actionCaptures = captures.map((capture, index) => ({ capture, index }));
  const stateIndex = indexStateValues(captures);
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);
  const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

  const multiStepBody = emitMultiStepExecuteHttp(
    actionSteps,
    inputBody,
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    new Set(),
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    BASE_URL,
    new Map(),
    new Map(),
    null,
    new Map(),
    new Map(),
    new Set(),
    [],
    new Map(),
    new Map(),
    SPEC
  );

  return emitContractTs({
    siteId: "foldreturn-nested-ancestor-drill-result-used-test",
    pascal: "FoldreturnNestedAncestorDrillResultUsedTest",
    baseUrl: BASE_URL,
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: captures[0]!.responseBody,
    gql: false,
    gqlQuery: null,
    endpointPath: "/catalog/sections",
    gqlOperationName: null,
    gqlVariables: null,
    auxFiles: [],
    actionSteps,
    foldReturnSpec: SPEC,
    multiStepBody,
    inputBody,
  });
}

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

describe("recon-generate foldReturn — two-level nested drill's httpClient response reaches every leaf item's data", () => {
  it("merges each leaf item's own drilled field into result.data, firing one httpClient POST per leaf item (not per group, not discarded)", async () => {
    const contract = generateContract();
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === SECTIONS_URL) {
        return jsonResponse({
          sections: [
            {
              id: "sec1",
              entries: [
                { entryId: "e1", name: "Widget" },
                { entryId: "e2", name: "Gadget" },
              ],
            },
            { id: "sec2", entries: [{ entryId: "e3", name: "Doohickey" }] },
          ],
        });
      }
      if (String(url) === ENTRY_DETAILS_URL) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { entryId: string };
        const detailByEntryId: Record<string, string> = {
          e1: "A widget.",
          e2: "A gadget.",
          e3: "A doohickey.",
        };
        const description = detailByEntryId[body.entryId];
        // Any request whose entryId isn't one of the three real leaf items
        // (the fixture's own trailing decoy replay, unmatched by any fold
        // target) gets an empty details array, like a real drilled endpoint
        // returning no match — never fabricates a description.
        return jsonResponse({
          details: description === undefined ? [] : [{ entryId: body.entryId, description }],
        });
      }
      throw new Error(`unstubbed fetch: ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const executeHttp = evalExecuteHttpBody(executeHttpBody, httpClient, z);
    const result = await executeHttp({ BaseUrl: BASE_URL, page: 1 });

    expect(result.data).toEqual({
      sections: [
        {
          id: "sec1",
          entries: [
            { entryId: "e1", name: "Widget", description: "A widget." },
            { entryId: "e2", name: "Gadget", description: "A gadget." },
          ],
        },
        {
          id: "sec2",
          entries: [{ entryId: "e3", name: "Doohickey", description: "A doohickey." }],
        },
      ],
    });

    // Exactly one drill POST per leaf item (3) — not one per group (which
    // would make 2 drills for 2 groups and be unable to give e1 and e2 their
    // own distinct descriptions), and not zero (the unused-httpClient-result
    // symptom the report flagged) — plus the fixture's own trailing decoy
    // replay (every real generated plugin re-issues every captured action,
    // matched fold targets or not), for 4 total.
    const detailCalls = fetchMock.mock.calls.filter(([url]) => String(url) === ENTRY_DETAILS_URL);
    expect(detailCalls).toHaveLength(4);
    const requestedEntryIds = detailCalls
      .map(
        ([, init]) => JSON.parse(String((init as RequestInit).body ?? "{}")) as { entryId: string }
      )
      .map((body) => body.entryId)
      .sort();
    expect(requestedEntryIds).toEqual(["e1", "e2", "e3", "undefined"]);
  });
});
