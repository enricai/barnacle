import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Bottleneck from "bottleneck";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  extractExecuteHttpBodyFromContract,
  stripEmitterTypeAssertions,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";

/**
 * REST (non-GraphQL) counterpart of recon-generate-graphql-paginated-fetch-loop.test.ts:
 * a plain-JSON own-backend capture (no operationName/query, so isGraphQL() is false) whose
 * response exposes a total/count field alongside a skip+count-shaped request-variables
 * container must get the same bounded paging loop the GraphQL primary path already gets --
 * issued via httpClient instead of getGql -- with the same identity-keyed de-duplication,
 * short-page/no-new-items halt guards, and preserved server total/deliveredCount/truncated
 * reporting.
 *
 * Exercises the real CLI (`tsx recon-generate.ts`), matching
 * recon-generate-graphql-paginated-fetch-loop.test.ts, since pagination detection lives
 * inside the un-exported `main`.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function restCapture(overrides: {
  phase: string;
  url: string;
  variables: Record<string, unknown> | null;
  responseBody: unknown;
}) {
  return {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: overrides.phase,
    method: "GET",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: null,
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: overrides.variables,
    decodedParams: null,
  };
}

/** 5 product-style item objects, each with a bare `id` identity field. */
function makeProductPage(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `prod-${i}`,
    title: `Product ${i}`,
  }));
}

/** A run dir whose primary REST operation's response exposes a total
 * alongside a skip+count request-variables container -- the bounded-paging
 * signal, with no GraphQL shape (operationName/query both null) anywhere. */
function writePagedRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const productSearch = restCapture({
    phase: "browse-the-products",
    url: "https://www.products-fixture.example.com/api/products/search",
    variables: { skip: 0, count: 5, sort: "RELEVANCE" },
    responseBody: { total: 15, items: makeProductPage(5) },
  });

  writeFileSync(
    join(root, "graphql", "000-browse-the-products-action.json"),
    JSON.stringify(productSearch)
  );
}

/** A sibling run dir whose primary REST operation has a request-variables
 * container but no total/count field in the response -- no bounded-paging
 * signal, so the existing single fixed-page call must be unchanged. */
function writeUnpagedRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const productSearch = restCapture({
    phase: "browse-the-products",
    url: "https://www.products-fixture.example.com/api/products/search",
    variables: { skip: 0, count: 5, sort: "RELEVANCE" },
    responseBody: { items: makeProductPage(5) },
  });

  writeFileSync(
    join(root, "graphql", "000-browse-the-products-action.json"),
    JSON.stringify(productSearch)
  );
}

function evalPaginatedExecuteHttp(
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

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate REST paginated fetch loop: total/count signal present", () => {
  it("emits a bounded paging loop issued via httpClient that advances skip, terminates on the observed total, and merges pages by identity", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-rest-paginated-fetch-loop-"));
    const runRoot = join(workDir, "run");
    writePagedRunDir(runRoot);

    const siteId = `rest-paginated-fetch-loop-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // Never GraphQL: no getGql machinery is emitted for a REST primary.
    expect(contract).not.toContain("getGql(");
    expect(contract).not.toContain("createGraphqlClient");

    // (a) The loop advances the pagination variable by the observed page count,
    // issuing each page via httpClient rather than getGql.
    expect(contract).toContain("const PAGE_SIZE = payload.pageSize ?? 5;");
    expect(contract).toContain("skip += PAGE_SIZE;");
    expect(contract).toContain("{ ...baseVariables, count: PAGE_SIZE, skip: skip }");
    expect(contract).toMatch(
      /await httpClient\(`\$\{context\.baseUrl\}\/api\/products\/search`, \{ method: "POST", body: JSON\.stringify\(/
    );

    // (b) It terminates once accumulated results reach the response's own reported
    // total, or a finite MAX_PAGES cap -- never an unbounded loop, never a TODO.
    expect(contract).toContain("const MAX_PAGES = payload.maxPages ?? 50;");
    expect(contract).toContain("total = page.total;");
    expect(contract).not.toMatch(/while\s*\(\s*true\s*\)/);
    expect(contract).not.toContain("TODO");

    // (b.1) The payload schema exposes maxPages as an optional caller override.
    expect(contract).toContain("maxPages: z.number().int().positive().optional(),");

    // (c) Pages are merged by an identity field discovered from the array element
    // shape, not concatenated blindly.
    expect(contract).toContain("itemsById.set(String(item.id), item);");
    expect(contract).toContain("[...itemsById.values()]");
    expect(contract).not.toMatch(/\.push\(\.\.\.(page|data)\.items\)/);

    // (d) The server's own reported total is preserved untouched; delivery and
    // truncation are exposed as separate sibling fields on the envelope.
    expect(contract).toContain("const truncated = itemsById.size < total;");
    expect(contract).toContain("{ ...withItems, deliveredCount: itemsById.size, truncated }");
  }, 30_000);

  it("actually drives multiple httpClient calls and de-dupes/halts correctly at runtime", async () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-rest-paginated-runtime-"));
    const runRoot = join(workDir, "run");
    writePagedRunDir(runRoot);

    const siteId = `rest-paginated-fetch-loop-runtime-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    const TOTAL_DISTINCT_IDS = 12;
    const PAGE_SIZE = 5;
    let callCount = 0;
    const fetchMock = vi.fn(async (_url: string, init: { body?: string }) => {
      const body = JSON.parse((init.body as string) ?? "{}") as { skip: number; count: number };
      callCount += 1;
      const remaining = Math.max(0, TOTAL_DISTINCT_IDS - body.skip);
      const pageItemCount = Math.min(body.count, remaining);
      return new Response(
        JSON.stringify({
          total: TOTAL_DISTINCT_IDS,
          items: Array.from({ length: pageItemCount }, (_, i) => ({
            id: `prod-${body.skip + i}`,
            title: `Product ${body.skip + i}`,
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: new Bottleneck({ maxConcurrent: 1, minTime: 0 }),
      baseHeaders: { "Content-Type": "application/json" },
    });

    const executeHttp = evalPaginatedExecuteHttp(executeHttpBody, httpClient);
    const { data } = await executeHttp(
      { pageSize: PAGE_SIZE },
      { baseUrl: "https://www.products-fixture.example.com" }
    );

    // ceil(12/5) = 3 page requests total.
    expect(callCount).toBe(3);
    expect((data as { deliveredCount: number; truncated: boolean }).deliveredCount).toBe(
      TOTAL_DISTINCT_IDS
    );
    expect((data as { truncated: boolean }).truncated).toBe(false);
    expect((data as { total: number }).total).toBe(TOTAL_DISTINCT_IDS);
  }, 30_000);
});

describe("recon-generate REST paginated fetch loop: no total/count signal", () => {
  it("still emits a single literal-page call, unchanged from current behavior", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-rest-unpaginated-fetch-"));
    const runRoot = join(workDir, "run");
    writeUnpagedRunDir(runRoot);

    const siteId = `rest-unpaginated-fetch-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    expect(contract).toContain(
      'const data = await httpClient(`${context.baseUrl}/api/products/search`, {\n' +
        '      method: "POST",\n' +
        "      body: JSON.stringify({ query: payload.query }),\n" +
        "    });"
    );
    expect(contract).not.toContain("MAX_PAGES");
    expect(contract).not.toContain("maxPages");
    expect(contract).not.toContain("itemsById");
  }, 30_000);
});
