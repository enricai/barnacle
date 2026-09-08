import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
  resolveFoldPlan,
} from "@/scripts/recon-generate";
import {
  extractExecuteHttpBodyFromContract,
  stripEmitterTypeAssertions,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";

const BASE = "https://api.example.com";

/**
 * `emitContractTs` (the real contract.ts generation entry point) hits the
 * same per-ancestor hoist bug 52a166f/cdd197d/29917e6 fixed for
 * `emitMultiStepExecuteHttp`, exercised here through a REST (non-GraphQL)
 * primary read: the drilled endpoint's literal query value equals ONLY the
 * matched (first) item's own `code` field — the group's own `code` field
 * holds a genuinely different value, and every other sibling item's own
 * `code` diverges too — the inverse of the scope-coincident case (where
 * item and ancestor literals happen to agree). Only a fold plan that proves
 * the drill is ancestor-scoped from its own response (it resolves onto
 * every sibling under the same group, not just the matched item) and
 * rebinds the drill's outgoing request onto the group's own `code` field
 * can hoist the fetch above the per-item loop and still join every sibling
 * correctly. Mirrors
 * recon-generate-contract-scope-coincident-drill-hoist-runtime-e2e.test.ts's
 * emitContractTs harness (#344) and reasserts the #330/#339 dedup guard.
 */

function sectionsSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/sections`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {
      sections: [
        {
          code: "sec1",
          entries: [
            { entryId: "item-1", code: "widget-code", name: "Widget" },
            { entryId: "item-2", code: "gadget-code", name: "Gadget" },
            { entryId: "item-3", code: "doohickey-code", name: "Doohickey" },
          ],
        },
        {
          code: "sec2",
          entries: [
            { entryId: "item-4", code: "thingamajig-code", name: "Thingamajig" },
            { entryId: "item-5", code: "contraption-code", name: "Contraption" },
            { entryId: "item-6", code: "gizmo-code", name: "Gizmo" },
          ],
        },
      ],
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function entryDetailsCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/entries/details?code=widget-code`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {
      details: [
        { entryId: "item-1", description: "A widget." },
        { entryId: "item-2", description: "A gadget." },
        { entryId: "item-3", description: "A doohickey." },
      ],
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function decoyDetailsCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:02Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/entries/details?code=zzz-unrelated`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { details: [{ entryId: "zzz-unrelated", description: "An unrelated entry." }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/entries/details",
  resultsPath: "sections.*.entries",
  drillResultsPath: "details",
  joinFields: ["entryId"],
};

function evalRestExecuteHttp(
  body: string,
  httpClient: ReturnType<typeof createHttpClient>
): (payload: Record<string, unknown>, context: { baseUrl: string }) => Promise<{ data: unknown }> {
  const stripped = stripEmitterTypeAssertions(body);
  const factory = new Function(
    "httpClient",
    "z",
    `return async function executeHttp(payload, context) {\n${stripped}\n};`
  ) as (
    httpClientArg: unknown,
    zArg: unknown
  ) => (
    payload: Record<string, unknown>,
    context: { baseUrl: string }
  ) => Promise<{ data: unknown }>;
  return factory(httpClient, z);
}

function stubSequentialFetch(bodies: unknown[]): void {
  const fn = vi.fn();
  for (const body of bodies) {
    fn.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify(body)),
      headers: new Headers(),
    });
  }
  vi.stubGlobal("fetch", fn);
}

function emitContract(): string {
  const captures = [
    sectionsSearchCapture(),
    entryDetailsCapture(),
    decoyDetailsCapture(),
  ] as never[];

  const actionCaptures = extractGraphQLActionSequence(captures, null, SPEC);
  const stateIndex = indexStateValues(
    captures,
    new Set(),
    new Set(actionCaptures.map((a) => a.index))
  );
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);

  const foldPlans = resolveFoldPlan(actionSteps, SPEC);
  expect(foldPlans.length).toBeGreaterThan(0);

  const primaryResponseBody = actionSteps[0]!.capture.responseBody;

  return emitContractTs({
    siteId: "item-literal-ancestor-scoped-hoist-test",
    pascal: "ItemLiteralAncestorScopedHoistTest",
    baseUrl: BASE,
    baseHeaders: {},
    minTime: 100,
    safeRps: 10,
    responseBody: primaryResponseBody,
    gql: false,
    gqlQuery: null,
    endpointPath: "/catalog/sections",
    gqlOperationName: null,
    gqlVariables: null,
    auxFiles: [],
    actionSteps,
    foldReturnSpec: SPEC,
  });
}

describe("emitContractTs — item-literal-but-ancestor-scoped drill param still hoists to the ancestor binding", () => {
  it("emits the drill fetch call site bound to the group field only, between the group and item loop opens, deduped to one call site", () => {
    const contract = emitContract();

    // #330/#339 dedup guard: exactly one drill `await httpClient(` call site
    // is ever emitted, regardless of how many items share the group.
    const drillCallSites =
      contract.match(/await httpClient\(`\$\{context\.baseUrl\}\/catalog\/entries\/details/g) ?? [];
    expect(drillCallSites.length).toBe(1);

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);
    const groupLoopIndex = executeHttpBody.indexOf("for (const g0 of");
    const drillFetchCallIndex = executeHttpBody.indexOf("catalog/entries/details?code=");
    const itemLoopIndex = executeHttpBody.indexOf("for (const item of");

    expect(groupLoopIndex).toBeGreaterThanOrEqual(0);
    expect(drillFetchCallIndex).toBeGreaterThanOrEqual(0);
    expect(itemLoopIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeLessThan(itemLoopIndex);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(executeHttpBody).toContain("catalog/entries/details?code=${g0.code}");
    expect(executeHttpBody).not.toContain("catalog/entries/details?code=${item");
  });

  it("leaves the primary read step as the batch sections read, not a per-item read", () => {
    const contract = emitContract();

    expect(contract).toContain("/catalog/sections");
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);
    expect(executeHttpBody.indexOf("/catalog/sections")).toBeLessThan(
      executeHttpBody.indexOf("for (const item of")
    );
  });

  it("at runtime, calls the drill endpoint exactly once per group and joins every sibling item correctly, including ones whose own field diverges", async () => {
    const contract = emitContract();

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: {},
    });

    // The primary sections read is the seeded initial fetch; only the two
    // group-scoped drill fetches follow.
    stubSequentialFetch([
      {
        sections: [
          {
            code: "sec1",
            entries: [
              { entryId: "item-1", code: "widget-code", name: "Widget" },
              { entryId: "item-2", code: "gadget-code", name: "Gadget" },
              { entryId: "item-3", code: "doohickey-code", name: "Doohickey" },
            ],
          },
          {
            code: "sec2",
            entries: [
              { entryId: "item-4", code: "thingamajig-code", name: "Thingamajig" },
              { entryId: "item-5", code: "contraption-code", name: "Contraption" },
              { entryId: "item-6", code: "gizmo-code", name: "Gizmo" },
            ],
          },
        ],
      },
      {
        details: [
          { entryId: "item-1", description: "A widget." },
          { entryId: "item-2", description: "A gadget." },
          { entryId: "item-3", description: "A doohickey." },
        ],
      },
      {
        details: [
          { entryId: "item-4", description: "A thingamajig." },
          { entryId: "item-5", description: "A contraption." },
          { entryId: "item-6", description: "A gizmo." },
        ],
      },
    ]);

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);
    const executeHttp = evalRestExecuteHttp(executeHttpBody, httpClient);
    const result = await executeHttp({}, { baseUrl: BASE });

    expect(result.data).toEqual({
      sections: [
        {
          code: "sec1",
          entries: [
            { entryId: "item-1", code: "widget-code", name: "Widget", description: "A widget." },
            { entryId: "item-2", code: "gadget-code", name: "Gadget", description: "A gadget." },
            {
              entryId: "item-3",
              code: "doohickey-code",
              name: "Doohickey",
              description: "A doohickey.",
            },
          ],
        },
        {
          code: "sec2",
          entries: [
            {
              entryId: "item-4",
              code: "thingamajig-code",
              name: "Thingamajig",
              description: "A thingamajig.",
            },
            {
              entryId: "item-5",
              code: "contraption-code",
              name: "Contraption",
              description: "A contraption.",
            },
            { entryId: "item-6", code: "gizmo-code", name: "Gizmo", description: "A gizmo." },
          ],
        },
      ],
    });

    // Exactly 3 fetches — the primary plus ONE drill per group (not one per
    // item, which would make 7 across a 2-group/3-item fixture, and not
    // just the matching item, which would silently drop siblings whose own
    // `code` diverges from `widget-code`/`thingamajig-code`).
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(3);
    expect(String(calls[1]![0])).toContain("code=sec1");
    expect(String(calls[2]![0])).toContain("code=sec2");
  });
});
