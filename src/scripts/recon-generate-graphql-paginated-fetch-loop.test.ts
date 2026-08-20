import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Acceptance test for the bounded GraphQL paging loop (buildPaginatedGqlExecuteHttpBody):
 * drives a captured primary operation whose response exposes a total/count field alongside a
 * skip-style pagination variable through the real CLI entrypoint and asserts the emitted
 * contract.ts's executeHttp advances the pagination variable, terminates on the reported total
 * (never an unbounded loop), and merges pages by an identity field. A sibling capture set with no
 * total/count signal proves the existing single fixed-page call is unchanged.
 *
 * Exercises the real CLI (`tsx recon-generate.ts`), matching
 * recon-generate-graphql-readonly-e2e.test.ts, since pagination detection lives inside the
 * un-exported `main`.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function gqlCapture(overrides: {
  phase: string;
  url: string;
  operationName: string | null;
  query: string | null;
  variables: Record<string, unknown> | null;
  responseBody: unknown;
}) {
  return {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: overrides.phase,
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: "{}",
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: overrides.operationName,
    query: overrides.query,
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

/** A run dir whose primary operation's response exposes a total alongside a
 * skip+count pagination variable — the bounded-paging signal. */
function writePagedRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const productSearch = gqlCapture({
    phase: "browse-the-products",
    url: "https://www.products-fixture.example.com/products/graph",
    operationName: "productSearch_Products",
    query:
      "query productSearch_Products($pagination: PaginationInput) { search(pagination: $pagination) { total items { id title } } }",
    variables: { pagination: { count: 5, skip: 0 }, sort: "RELEVANCE" },
    responseBody: { search: { total: 15, items: makeProductPage(5) } },
  });

  writeFileSync(
    join(root, "graphql", "000-browse-the-products-action.json"),
    JSON.stringify(productSearch)
  );
}

/** A sibling run dir whose primary operation has a pagination variable but no
 * total/count field in the response — no bounded-paging signal. */
function writeUnpagedRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const productSearch = gqlCapture({
    phase: "browse-the-products",
    url: "https://www.products-fixture.example.com/products/graph",
    operationName: "productSearch_Products",
    query:
      "query productSearch_Products($pagination: PaginationInput) { search(pagination: $pagination) { items { id title } } }",
    variables: { pagination: { count: 5, skip: 0 }, sort: "RELEVANCE" },
    responseBody: { search: { items: makeProductPage(5) } },
  });

  writeFileSync(
    join(root, "graphql", "000-browse-the-products-action.json"),
    JSON.stringify(productSearch)
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

describe("recon-generate GraphQL paginated fetch loop: total/count signal present", () => {
  it("emits a bounded paging loop that advances skip, terminates on the observed total, and merges pages by identity", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-graphql-paginated-fetch-loop-"));
    const runRoot = join(workDir, "run");
    writePagedRunDir(runRoot);

    const siteId = `graphql-paginated-fetch-loop-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // (a) The loop advances the pagination variable by the observed page count.
    expect(contract).toContain("const PAGE_SIZE = 5;");
    expect(contract).toContain("skip += PAGE_SIZE;");
    expect(contract).toContain(
      "pagination: { ...baseVariables.pagination, count: PAGE_SIZE, skip: skip }"
    );

    // (b) It terminates once accumulated results reach the response's own reported
    // total, or a finite MAX_PAGES cap — never an unbounded loop, never a TODO.
    expect(contract).toContain("const MAX_PAGES = 50;");
    expect(contract).toContain("total = page.search.total;");
    expect(contract).not.toMatch(/while\s*\(\s*true\s*\)/);
    expect(contract).not.toContain("TODO");

    // (c) Pages are merged by an identity field discovered from the array element
    // shape, not concatenated blindly.
    expect(contract).toContain("itemsById.set(String(item.id), item);");
    expect(contract).toContain("[...itemsById.values()]");
    expect(contract).not.toMatch(/\.push\(\.\.\.(page|data)\.search\.items\)/);
  }, 30_000);
});

describe("recon-generate GraphQL paginated fetch loop: no total/count signal", () => {
  it("still emits a single literal-page call, unchanged from current behavior", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-graphql-unpaginated-fetch-"));
    const runRoot = join(workDir, "run");
    writeUnpagedRunDir(runRoot);

    const siteId = `graphql-unpaginated-fetch-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    expect(contract).toMatch(
      /const data = await getGql\(context\.baseUrl\)\("productSearch_Products", \w+_QUERY, \{ pagination: \{"count":5,"skip":0\}, sort: "RELEVANCE" \}\);\n\s*return \{ data \};/
    );
    expect(contract).not.toContain("MAX_PAGES");
    expect(contract).not.toContain("itemsById");
  }, 30_000);
});
