import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * CLI-boundary regression for the reported scenario: a read-only search flow
 * that declares `ownBackendHostnames` (host-provenance gating engaged) with a
 * GraphQL search primary re-issued densely (>=10x, varying variables/response)
 * plus a single REST-shaped drill GET matching the declared `foldReturn`
 * endpointPattern. Neither the host-provenance switch nor the dense-repeat
 * shape alone reproduced the report; this exercises both together through the
 * real `recon-generate.ts` CLI, generically (no site names).
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "api.example.com";
const SEARCH_QUERY =
  "query catalogSearch($filter: String) { catalogSearch(filter: $filter) { items { id title } } }";
const REPEAT_COUNT = 19;

function searchCapture(page: number, timestamp: string): unknown {
  const filter = `outdoor-${String(page).padStart(2, "0")}`;
  return {
    timestamp,
    phase: "browse",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: { filter } }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      catalogSearch: {
        items: [
          { id: `item-${filter}-1`, title: "Item 1" },
          { id: `item-${filter}-2`, title: "Item 2" },
        ],
      },
    },
    operationName: "catalogSearch",
    query: SEARCH_QUERY,
    variables: { filter },
    decodedParams: null,
  };
}

function drillCapture(itemId: string, timestamp: string): unknown {
  return {
    timestamp,
    phase: "browse",
    method: "GET",
    url: `https://${OWN_BACKEND_HOST}/catalog/api/v1/details?id=${itemId}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { detail: [{ id: itemId, region: "region-A" }] },
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
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  Array.from({ length: REPEAT_COUNT }, (_, i) =>
    searchCapture(i, `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`)
  ).forEach((capture, i) => {
    writeFileSync(
      join(root, "graphql", `${String(i).padStart(3, "0")}-browse-search.json`),
      JSON.stringify(capture)
    );
  });

  const firstFilter = `outdoor-${String(0).padStart(2, "0")}`;
  writeFileSync(
    join(root, "graphql", `${String(REPEAT_COUNT).padStart(3, "0")}-browse-drill.json`),
    JSON.stringify(
      drillCapture(
        `item-${firstFilter}-1`,
        `2024-01-01T00:00:${String(REPEAT_COUNT).padStart(2, "0")}Z`
      )
    )
  );
}

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [{ step: "search the catalog" }],
      ownBackendHostnames: [OWN_BACKEND_HOST],
      foldReturn: {
        endpointPattern: "/catalog/api/v1/details",
        resultsPath: "catalogSearch.items",
        drillResultsPath: "detail",
        joinFields: ["id"],
      },
    })
  );
}

function runGenerate(runRoot: string, siteId: string): ReturnType<typeof spawnSync> {
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

describe("recon-generate CLI — host-provenance-declaring read-only search flow with a densely-repeated GraphQL search primary", () => {
  it("resolves a fold plan and never logs 'no fold plan resolved'", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-graphql-search-primary-host-provenance-fold-candidate-pool-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `graphql-search-primary-host-provenance-fold-candidate-pool-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = runGenerate(runRoot, siteId);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("no fold plan resolved");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("title");
    expect(contract).toContain("region");
  }, 30_000);
});
