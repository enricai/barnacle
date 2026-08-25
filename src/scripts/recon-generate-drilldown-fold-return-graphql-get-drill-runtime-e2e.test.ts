import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Reproduces the reported failure end to end through the real `recon-generate`
 * CLI: a GraphQL `query`-kind primary (`productSearch`) resolving a declared
 * `foldReturn.resultsPath` to a real object-array of items, plus a later
 * captured `GET` REST drill-down matching `foldReturn.endpointPattern` that
 * returns the same join id per item. Before the fix, `extractGraphQLActionSequence`
 * admitted the drill-down capture (endpointPattern match) but dropped the
 * `productSearch` query itself — it is neither a mutation nor an
 * endpointPattern match — leaving `resolveFoldPlan` with no primary capture
 * to resolve `resultsPath` against, so `main()` logged "no fold plan
 * resolved" and the generated contract never referenced the drill endpoint.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const SEARCH_QUERY = "query productSearch { productSearch { results { id name } } }";

function graphqlSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      productSearch: {
        results: [
          { id: "sku-a", name: "Widget" },
          { id: "sku-b", name: "Gadget" },
        ],
      },
    },
    operationName: "productSearch",
    query: SEARCH_QUERY,
    variables: {},
    decodedParams: null,
  };
}

function restDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: "https://example.com/inventory/api/v1/items?id=sku-a",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { items: [{ id: "sku-a", qty: 7 }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(
    join(root, "graphql", "000-browse-search.json"),
    JSON.stringify(graphqlSearchCapture())
  );
  writeFileSync(
    join(root, "graphql", "001-browse-drill.json"),
    JSON.stringify(restDrillDownCapture())
  );
}

function writeFlowFile(siteOutDir: string, opts: { withFoldReturn: boolean }): void {
  mkdirSync(siteOutDir, { recursive: true });
  const flow: Record<string, unknown> = {
    steps: [{ step: "search for products" }],
  };
  if (opts.withFoldReturn) {
    flow.foldReturn = {
      endpointPattern: "/inventory/api/v1/items",
      resultsPath: "productSearch.results",
      drillResultsPath: "items",
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

describe("recon-generate GraphQL-primary + GET REST drill-down foldReturn — runtime e2e", () => {
  it("resolves a fold plan and emits the drill endpoint in the generated contract, with no warning", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-get-drill-fold-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `gql-get-drill-fold-test-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir, { withFoldReturn: true });

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).not.toContain("no fold plan resolved");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("/inventory/api/v1/items");
  }, 30_000);

  it("falsifier: without the declared foldReturn, the same captures warn and the contract omits the drill endpoint (control)", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-get-drill-nofold-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `gql-get-drill-nofold-test-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir, { withFoldReturn: false });

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain("/inventory/api/v1/items");
  }, 30_000);
});
