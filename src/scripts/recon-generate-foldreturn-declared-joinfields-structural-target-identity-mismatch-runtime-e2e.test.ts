import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

const BASE_URL = "https://api.example.com";
const SEARCH_URL = `${BASE_URL}/catalog/search`;

/**
 * Two primary items, each driving its OWN per-item drill-down at a
 * DISTINCT endpoint identity (`/catalog/details/widget-01/`,
 * `/catalog/details/widget-02/`) — a genuinely per-item drill loop, not one
 * template call re-issued with a substituted id. Both drill requests carry
 * the SAME `sku` body field (both items share `sku: "std"`), so the
 * structural heuristic threads `sku` as its own guessed `joinFields` for
 * EVERY target it resolves. A declared `foldReturn.joinFields:
 * ["confirmationId"]` names a field that never threads into either drill's
 * request and is resolvable only against each drill's own response.
 *
 * `buildFoldPlanFromSpec`'s freshest-first scan across matching drill
 * endpoints resolves (and `break`s on) only ONE endpoint per unrestricted
 * call, so without per-target `restrictToDrillEndpointKey` resolution
 * (recon-generate.ts:9634-9918), only ONE of the two structural targets
 * gets its declared override applied while the other keeps the `sku`
 * structural guess — the still-open gap in `emitMultiStepExecuteHttp`'s
 * per-item loop, the sibling of the single-primary getGql/httpClient path
 * already covered by
 * recon-generate-foldreturn-declared-joinfields-response-only-single-primary-override-runtime-e2e.test.ts.
 */
function fixtureCaptures(): Capture[] {
  const search = buildCapture({
    url: SEARCH_URL,
    requestPostData: '{"page":1}',
    responseBody: {
      results: [
        { sku: "std", confirmationId: "conf-01" },
        { sku: "std", confirmationId: "conf-02" },
      ],
    },
    timestamp: "2026-01-01T00:00:00Z",
  });
  const detailsOne = buildCapture({
    url: `${BASE_URL}/catalog/details/widget-01/`,
    requestPostData: '{"sku":"std"}',
    responseBody: {
      candidates: [{ sku: "std", confirmationId: "conf-01", price: 100 }],
    },
    timestamp: "2026-01-01T00:00:01Z",
  });
  const detailsTwo = buildCapture({
    url: `${BASE_URL}/catalog/details/widget-02/`,
    requestPostData: '{"sku":"std"}',
    responseBody: {
      candidates: [{ sku: "std", confirmationId: "conf-02", price: 200 }],
    },
    timestamp: "2026-01-01T00:00:02Z",
  });
  return [search, detailsOne, detailsTwo];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/details/",
  resultsPath: "results",
  drillResultsPath: "candidates",
  joinFields: ["confirmationId"],
};

function buildMultiStepBody(): string {
  const captures = fixtureCaptures();
  const actionCaptures = captures.map((capture, index) => ({ capture, index }));
  const stateIndex = indexStateValues(captures);
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);
  const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

  return emitMultiStepExecuteHttp(
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

function stubFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string) => {
    if (url.includes("/catalog/search")) {
      return jsonResponse({
        results: [
          { sku: "std", confirmationId: "conf-01" },
          { sku: "std", confirmationId: "conf-02" },
        ],
      });
    }
    if (url.includes("/catalog/details/widget-01/")) {
      return jsonResponse({ candidates: [{ sku: "std", confirmationId: "conf-01", price: 100 }] });
    }
    if (url.includes("/catalog/details/widget-02/")) {
      return jsonResponse({ candidates: [{ sku: "std", confirmationId: "conf-02", price: 200 }] });
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("recon-generate foldReturn declared joinFields — structural-target identity mismatch across a multi-step per-item drill loop", () => {
  it("emits the declared confirmationId join key on BOTH per-item drill targets, not the shared sku structural guess", () => {
    const body = buildMultiStepBody();

    expect(body.match(/m\["confirmationId"\]/g)?.length).toBe(2);
    expect(body).not.toContain('m["sku"]');
    expect(body.match(/const foldMatches/g)?.length).toBe(2);
  });

  it("folds each per-item drill's response by the declared confirmationId at runtime, never the shared sku decoy", async () => {
    const body = buildMultiStepBody();

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    const fetchMock = stubFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: BASE_URL, page: 1 });

    expect(result.data).toEqual({
      results: [
        { sku: "std", confirmationId: "conf-01", price: 100 },
        { sku: "std", confirmationId: "conf-02", price: 200 },
      ],
    });
    // One primary search call, plus each item re-issuing BOTH per-item
    // drill targets (widget-01 and widget-02) since the fold loop cannot
    // know in advance which target's response matches a given item; only
    // the declared confirmationId join correctly discards the non-matching
    // target's response for each item.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
