import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Reproduces the reported failure through the real `recon-generate` CLI: a
 * GraphQL search primary whose ONLY operation-identity signal is the name
 * embedded in its query text — every occurrence's raw `operationName` field
 * is null, the shape most GraphQL clients that send only an inline named
 * document actually produce. The primary is fired 19 times with distinct
 * `page` variables and distinct response bodies, each with an explicit
 * `application/json` content-type, landing on the dense-repeat
 * freely-varying-response branch. It is joined to a drill-down GET via a
 * flow-declared `foldReturn` whose `resultsPath` crosses a nested wildcard
 * array field. Before the fix, `isGraphQL()` (recon-generate.ts) only
 * trusted the raw `operationName` field, so this exact capture set was
 * misclassified as REST-only and routed through the REST-only
 * `extractActionSequence` pipeline, discarding the declared `foldReturn`
 * without any diagnostic.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const SEARCH_QUERY =
  "query catalogSearch($page: Int) { catalogSearch(page: $page) { results { items { id variants { id price } } } } }";

function catalogSearchCapture(page: number, timestamp: string): unknown {
  return {
    timestamp,
    phase: "browse",
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: { page } }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      data: {
        catalogSearch: {
          results: {
            items: [
              {
                id: "item-fixed",
                variants: [{ id: "variant-fixed", price: 100 + page }],
              },
            ],
          },
        },
      },
    },
    operationName: null,
    query: SEARCH_QUERY,
    variables: { page },
    decodedParams: null,
  };
}

function variantDrillCapture(variantId: string, timestamp: string): unknown {
  return {
    timestamp,
    phase: "browse",
    method: "GET",
    url: `https://example.com/catalog/api/v1/variant-detail?variantId=${variantId}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ id: variantId, price: 999 }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const REPEAT_COUNT = 19;

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  Array.from({ length: REPEAT_COUNT }, (_, i) => i).forEach((i) => {
    writeFileSync(
      join(root, "graphql", `${String(i).padStart(3, "0")}-browse-search.json`),
      JSON.stringify(catalogSearchCapture(i, `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`))
    );
  });
  writeFileSync(
    join(root, "graphql", `${String(REPEAT_COUNT).padStart(3, "0")}-browse-drill.json`),
    JSON.stringify(
      variantDrillCapture(
        "variant-fixed",
        `2024-01-01T00:00:${String(REPEAT_COUNT).padStart(2, "0")}Z`
      )
    )
  );
}

function writeFlowFile(siteOutDir: string, opts: { withFoldReturn: boolean }): void {
  mkdirSync(siteOutDir, { recursive: true });
  const flow: Record<string, unknown> = {
    steps: [{ step: "search the catalog" }],
  };
  if (opts.withFoldReturn) {
    flow.foldReturn = {
      endpointPattern: "/catalog/api/v1/variant-detail",
      resultsPath: "data.catalogSearch.results.items.*.variants",
      drillResultsPath: "detail",
      joinFields: ["id"],
    };
  }
  writeFileSync(join(siteOutDir, "recon-flow.json"), JSON.stringify(flow));
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function run(runRoot: string, siteId: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

describe("GraphQL search primary named only in its query text (operationName always null) — fold plan resolution", () => {
  it("resolves the declared foldReturn instead of emitting 'no fold plan resolved'", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-query-text-only-fold-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `gql-query-text-only-fold-test-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir, { withFoldReturn: true });

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).not.toContain("no fold plan resolved");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("/catalog/api/v1/variant-detail");
    expect(contract).toContain("variants");
    expect(contract).toContain("price");
  }, 30_000);
});
