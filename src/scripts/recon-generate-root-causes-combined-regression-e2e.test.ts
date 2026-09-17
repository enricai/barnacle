import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Bottleneck from "bottleneck";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { HttpClientError } from "@/scraper/errors";
import { createHttpClient } from "@/scraper/http-client";
import { emitContractTs } from "@/scripts/recon-generate";
import {
  evalExecuteHttpBody,
  extractExecuteHttpBodyFromContract,
  stripEmitterTypeAssertions,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Combined acceptance test proving all eight root-cause fixes from
 * recon-royalcaribbean-plugin-root-causes.md interoperate on a single
 * site-agnostic (fictitious listings/booking) fixture, matching this repo's
 * own convention of a trailing combined regression test after a batch of
 * related fixes. Each `it()` exercises the fixes at the layer they actually
 * live in, and each fixture is built so it would have failed on the
 * described pre-fix behavior:
 *
 * - item 0 (noise-admission): a widened queryless-repeat pattern that used
 *   to under-fire and let noise compete for fold-plan primary selection.
 * - item 2 (drill isolation): a per-item fold/drill loop that used to be a
 *   bare sequential `for await` with no per-item failure isolation.
 * - item 4/5 (paging): a frozen PAGE_SIZE with no caller override, and a
 *   capped/short paging loop that used to overwrite the server's `total`
 *   with the delivered count.
 * - item 1/3 (http-client): a non-nullable schema leaf reading `null` on a
 *   legitimate empty 2xx result used to hard-fail into a schema error, and a
 *   non-JSON 4xx body used to reach JSON.parse before status classification.
 * - item 6/7 (generator config): no caller-facing facet/capacity validation,
 *   and no flow-declarable browser-fallback gate/timeout.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
}

function runGenerate(siteId: string, runRoot: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon root-causes combined regression: noise admission, drill isolation, paging", () => {
  it("excludes a widened queryless-repeat noise family from fold-plan primary selection while still emitting a parallel, per-item-isolated drill loop", async () => {
    const OWN_BACKEND_HOST = "www.combined-root-causes-fixture.example.com";
    const LISTING_URL = `https://${OWN_BACKEND_HOST}/available-products/`;
    const DRILL_URL = `https://${OWN_BACKEND_HOST}/available-units/`;
    // Same-origin, queryless widget noise — repeats far more often than the
    // real primary and carries no business-relevant response state (an empty
    // object), the exact shape item 0's widened
    // `isZeroVarianceRepeatCapture` queryless branch must classify as noise.
    const NOISE_URL = `https://${OWN_BACKEND_HOST}/pulse/urgency-widget`;
    const NOISE_REPEAT_COUNT = 12;
    const ITEM_COUNT = 6;
    const FAILING_ID = "unit-3";

    workDir = mkdtempSync(join(tmpdir(), "barnacle-combined-root-causes-"));
    const runRoot = join(workDir, "run");

    const ids = Array.from({ length: ITEM_COUNT }, (_, i) => `unit-${i}`);
    const listing = buildCapture({
      url: LISTING_URL,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { results: ids.map((id) => ({ id })) },
      timestamp: "2026-01-01T00:00:00Z",
    });
    const drillOne = buildCapture({
      url: DRILL_URL,
      requestPostData: JSON.stringify({ id: "unit-0" }),
      responseBody: { detail: [{ id: "unit-0", price: 42 }] },
      timestamp: "2026-01-01T00:00:01Z",
    });
    const noise = Array.from({ length: NOISE_REPEAT_COUNT }, (_, i) =>
      buildCapture({
        url: NOISE_URL,
        requestPostData: null,
        responseBody: {},
        timestamp: `2026-01-01T00:00:${String(2 + i).padStart(2, "0")}Z`,
      })
    );

    writeRunDir(runRoot, [listing, drillOne, ...noise]);

    const siteId = `combined-root-causes-noise-drill-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse product listing" },
          { step: "drill into unit availability", submitStep: true },
        ],
        submitEndpointPattern: "available-units",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = runGenerate(siteId, runRoot);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // Item 0: the noise family never wins (or even survives into) fold-plan
    // primary selection — the real listing/drill endpoints are what's
    // emitted, not the far-more-frequent noise endpoint.
    expect(contract).not.toContain("pulse/urgency-widget");
    expect(contract).toContain("available-products/");
    expect(contract).toContain("available-units/");

    // Item 2: the per-item drill loop dispatches through Promise.allSettled,
    // not a bare sequential for-await with no per-item isolation.
    expect(contract).toMatch(/Promise\.allSettled\(/);
    expect(contract).toMatch(/foldItems\)\.map\(async \(item\) => \{/);

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);
    const limiter = new Bottleneck({ maxConcurrent: ITEM_COUNT, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    const maxInFlight = { value: 0 };
    let inFlight = 0;
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
      const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      if (requestBody === null || typeof requestBody.page === "number") {
        return Promise.resolve({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ results: ids.map((id) => ({ id })) })),
          headers: new Headers(),
        });
      }
      const id = requestBody.id as string;
      inFlight++;
      maxInFlight.value = Math.max(maxInFlight.value, inFlight);
      return new Promise((resolve) => {
        setTimeout(() => {
          inFlight--;
          if (id === FAILING_ID) {
            resolve({
              status: 403,
              ok: false,
              text: vi.fn().mockResolvedValue(JSON.stringify({ error: "forbidden" })),
              headers: new Headers(),
            });
            return;
          }
          resolve({
            status: 200,
            ok: true,
            text: vi.fn().mockResolvedValue(JSON.stringify({ detail: [{ id, price: 42 }] })),
            headers: new Headers(),
          });
        }, 20);
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const executeHttp = evalExecuteHttpBody(executeHttpBody, httpClient, z);
    const runtimeResult = await executeHttp({ BaseUrl: `https://${OWN_BACKEND_HOST}`, page: 1 });

    const data = runtimeResult.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toHaveLength(ITEM_COUNT);
    const byId = new Map((data.results ?? []).map((item) => [item.id as string, item]));
    for (const id of ids) {
      if (id === FAILING_ID) {
        expect(byId.get(id)).toEqual({ id });
        continue;
      }
      expect(byId.get(id)).toEqual({ id, price: 42 });
    }
    // A sequential loop could never have more than one drill call
    // outstanding within the stub's latency window — proves genuine
    // per-item concurrency survives even with one item's fetch rejecting.
    expect(maxInFlight.value).toBeGreaterThan(1);
  }, 30_000);

  it("overrides the frozen page size and preserves the server's total alongside deliveredCount/truncated when paging stops short", async () => {
    const BASE = "https://api.combined-root-causes-fixture.example.com";
    const SEARCH_QUERY =
      "query catalogSearch($pagination: PaginationInput) { catalog(pagination: $pagination) { total items { id title } } }";

    function makeItems(count: number, startIndex: number): Record<string, unknown>[] {
      return Array.from({ length: count }, (_, i) => ({
        id: `item-${startIndex + i}`,
        title: `Item ${startIndex + i}`,
      }));
    }

    const contract = emitContractTs({
      siteId: "catalog-combined-root-causes-paging-test",
      pascal: "CatalogCombinedRootCausesPagingTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { catalog: { total: 20, items: makeItems(5, 0) } },
      gql: true,
      gqlQuery: SEARCH_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "catalogSearch",
      gqlVariables: { pagination: { count: 5, skip: 0 } },
      auxFiles: [],
      actionSteps: [],
    });

    // Item 4: a caller-supplied pageSize is declared and overridable.
    expect(contract).toMatch(/pageSize\??:\s*z\.(coerce\.)?number\(\)[\w.()]*\.optional\(\)/);

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);
    const stripped = stripEmitterTypeAssertions(executeHttpBody);
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: new Bottleneck({ maxConcurrent: 1, minTime: 0 }),
      baseHeaders: { "Content-Type": "application/json" },
    });

    function evalPaginated(
      getGql: (
        baseUrl: string
      ) => (
        operationName: string,
        query: string,
        variables: Record<string, unknown>
      ) => Promise<unknown>
    ) {
      const factory = new Function(
        "getGql",
        "httpClient",
        "z",
        "CATALOGCOMBINEDROOTCAUSESPAGINGTEST_QUERY",
        `return async function executeHttp(payload, context) {\n${stripped}\n};`
      ) as (
        getGqlArg: unknown,
        httpClientArg: unknown,
        zArg: unknown,
        queryArg: string
      ) => (
        payload: Record<string, unknown>,
        context: { baseUrl: string }
      ) => Promise<{ data: unknown }>;
      return factory(getGql, httpClient, z, SEARCH_QUERY);
    }

    // Item 4: a pageSize of 20 fetches all 20 items in a single request
    // instead of the capture-time-frozen page size of 5.
    let overrideCallCount = 0;
    const overrideExecuteHttp = evalPaginated((_baseUrl: string) => async (_op, _q, variables) => {
      overrideCallCount += 1;
      const pagination = variables.pagination as { skip: number; count: number };
      const remaining = Math.max(0, 20 - pagination.skip);
      return {
        catalog: {
          total: 20,
          items: makeItems(Math.min(pagination.count, remaining), pagination.skip),
        },
      };
    });
    const overrideResult = await overrideExecuteHttp({ pageSize: 20 }, { baseUrl: BASE });
    expect(overrideCallCount).toBe(1);
    expect((overrideResult.data as { catalog: { items: unknown[] } }).catalog.items).toHaveLength(
      20
    );

    // Item 5: when the server's own total overstates the distinct items
    // actually available (mirroring total=437-vs-436-distinct-ids), the loop
    // stops as soon as a page contributes nothing new, the merged envelope's
    // `total` is left untouched at the server's own value, and delivery vs.
    // truncation are exposed as sibling fields instead of overwriting total.
    const shortPages = [
      { catalog: { total: 10, items: makeItems(5, 0) } },
      { catalog: { total: 10, items: makeItems(3, 5) } },
      { catalog: { total: 10, items: [] } },
    ];
    let shortCallIndex = 0;
    const shortExecuteHttp = evalPaginated((_baseUrl: string) => async () => {
      const page = shortPages[shortCallIndex];
      shortCallIndex += 1;
      return page;
    });
    const shortResult = await shortExecuteHttp({}, { baseUrl: BASE });
    expect(shortCallIndex).toBe(3);
    expect((shortResult.data as { catalog: { items: unknown[] } }).catalog.items).toHaveLength(8);
    expect((shortResult.data as { catalog: { total: number } }).catalog.total).toBe(10);
    expect((shortResult.data as unknown as { deliveredCount: number }).deliveredCount).toBe(8);
    expect((shortResult.data as unknown as { truncated: boolean }).truncated).toBe(true);
  });

  it("classifies a non-JSON 4xx body without JSON-parsing it, and tolerates a null scalar on an otherwise-valid 2xx result without cascading", async () => {
    const ItemSchema = z.object({
      results: z.array(z.unknown()),
      recommendationId: z.string(),
    });
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const client = createHttpClient<z.infer<typeof ItemSchema>>({
      schema: ItemSchema,
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    // Item 1: a legitimate zero-match 2xx result whose non-nullable
    // `recommendationId` leaf reads `null` resolves as data instead of
    // throwing HttpSchemaError (which would otherwise cascade into the
    // browser fallback).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify({ results: [], recommendationId: null })),
        headers: new Headers(),
      })
    );
    const emptyResult = await client("https://api.example.com/search");
    expect(emptyResult).toEqual({ results: [], recommendationId: null });

    // Item 3: a deterministic, non-JSON 404 (an HTML error page) is
    // classified as HttpClientError before the body is ever JSON.parse'd —
    // never surfaces as a generic retryable UnknownScraperError.
    const textFn = vi.fn().mockResolvedValue("<html>Not Found</html>");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        status: 404,
        ok: false,
        text: textFn,
        headers: new Headers(),
      })
    );
    await expect(client("https://api.example.com/detail/unit-99")).rejects.toBeInstanceOf(
      HttpClientError
    );
  });

  it("emits caller-facing value constraints and a flow-declared browser-fallback gate/timeout together, without either regressing the other", () => {
    const OWN_BACKEND_HOST = "www.combined-root-causes-config-fixture.example.com";
    const SEARCH_URL = `https://${OWN_BACKEND_HOST}/lodging/search/`;
    const HOLD_URL = `https://${OWN_BACKEND_HOST}/lodging/hold/`;
    const CONFIRM_URL = `https://${OWN_BACKEND_HOST}/lodging/confirm/`;

    workDir = mkdtempSync(join(tmpdir(), "barnacle-combined-root-causes-config-"));
    const runRoot = join(workDir, "run");

    const search = buildCapture({
      url: SEARCH_URL,
      requestPostData: JSON.stringify({ query: "lakeside" }),
      responseBody: { results: [{ unitId: "unit-a" }] },
      timestamp: "2026-05-01T00:00:00Z",
    });
    const hold = buildCapture({
      url: HOLD_URL,
      requestPostData: JSON.stringify({ unitId: "unit-a", unitPlan: "Standard", partySize: 2 }),
      responseBody: { held: true },
      timestamp: "2026-05-01T00:00:01Z",
    });
    const confirm = buildCapture({
      url: CONFIRM_URL,
      requestPostData: JSON.stringify({ unitId: "unit-a", unitPlan: "Deluxe", partySize: 3 }),
      responseBody: { confirmed: true, partyCapacityLimit: 4 },
      timestamp: "2026-05-01T00:00:02Z",
    });
    writeRunDir(runRoot, [search, hold, confirm]);

    const siteId = `combined-root-causes-config-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "search for a lakeside unit" },
          { step: "place a hold on the selected unit" },
          { step: "confirm the unit hold", submitStep: true },
        ],
        submitEndpointPattern: "lodging/confirm",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
        // Item 7: the browser fallback has never once succeeded live for
        // this class of site — declared gated off for schema-drift/bot
        // challenges, with a short per-call timeout instead of the 65-86s
        // engine default.
        browserFallbackGate: ["HttpServerError", "HttpRateLimitError"],
        httpTimeoutMs: 4000,
      })
    );

    const result = runGenerate(siteId, runRoot);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // Item 7: the flow-declared gate/timeout reach the emitted contract.
    expect(contract).toContain(
      `browserFallbackGate: (error) => ["HttpServerError","HttpRateLimitError"].includes(error.name),`
    );
    expect(contract).toContain("defaultTimeoutMs: 4000");

    // Item 6: a closed-set facet field gets z.enum(...), and a numeric field
    // paired with a same-run capacity ceiling gets a bounded z.number().
    expect(contract).toMatch(/unitPlan:\s*z\.enum\(\[[^\]]*\]\),/);
    expect(contract).toMatch(/partySize:\s*z\.number\(\)\.max\(4\),/);

    const payloadSchemaMatch = contract.match(
      /const \w+PayloadSchema = ([\s\S]*?);\n\nexport type/
    );
    expect(payloadSchemaMatch, contract).not.toBeNull();
    const PayloadSchema = new Function("z", `return ${payloadSchemaMatch![1]!};`)(z) as z.ZodType;

    const BASE_VALID_PAYLOAD = {
      BaseUrl: `https://${OWN_BACKEND_HOST}`,
      query: "lakeside",
      unitId: "unit-a",
    };
    expect(
      PayloadSchema.safeParse({ ...BASE_VALID_PAYLOAD, unitPlan: "Standard", partySize: 2 }).success
    ).toBe(true);
    expect(
      PayloadSchema.safeParse({
        ...BASE_VALID_PAYLOAD,
        unitPlan: "PresidentialSuite",
        partySize: 2,
      }).success
    ).toBe(false);
    expect(
      PayloadSchema.safeParse({ ...BASE_VALID_PAYLOAD, unitPlan: "Standard", partySize: 99 })
        .success
    ).toBe(false);
  }, 30_000);
});
