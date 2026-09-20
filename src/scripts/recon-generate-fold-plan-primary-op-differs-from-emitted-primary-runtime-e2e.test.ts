import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Reproduces docs/recon-generate-fold-plan-primary-op-can-differ-from-emitted-primary-op.md
 * end to end through the real `recon-generate` CLI: two distinct GraphQL
 * query operations on the same endpoint. `catalogFacets` (op A) is a
 * facets/config response with no results array, captured more often, so
 * `selectPrimaryGraphQLOperation`'s recurrenceScore picks it as the emitted
 * primary. `catalogSearch` (op B) carries the nested array the flow's
 * declared `foldReturn.resultsPath` names, captured once. Before bugfix-001,
 * `buildFoldPlanFromSpec`/`detectDrillDownFoldPlan` resolved their primary
 * candidate purely structurally, with no anchor to the operation already
 * selected as the emitted primary, so they could resolve the fold plan's
 * `primaryStepIndex` against op B while `data` at runtime actually holds op
 * A's response — a cast that can never typecheck. `emitContractTs` used to
 * catch this after the fact with a throw; now the resolution itself is
 * constrained to the emitted primary's identity (op A), so op B's fold plan
 * can never resolve in the first place. This asserts `recon-generate` exits
 * 0, logs that no fold plan resolved, and never emits a fold cast/merge
 * referencing op B's shape.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const FACETS_QUERY = "query catalogFacets { catalog { filters { name values } } }";
const SEARCH_QUERY = "query catalogSearch { catalog { results { items { id name } } } }";

function graphqlFacetsCapture(index: number): unknown {
  return {
    timestamp: `2024-01-01T00:00:0${index}Z`,
    phase: "browse",
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: FACETS_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      catalog: {
        filters: [
          { name: "color", values: ["red", "blue"] },
          { name: "size", values: ["s", "m", "l"] },
        ],
      },
    },
    operationName: "catalogFacets",
    query: FACETS_QUERY,
    variables: {},
    decodedParams: null,
  };
}

function graphqlSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:10Z",
    phase: "browse",
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      catalog: {
        results: {
          items: [
            { id: "item-a", name: "Widget" },
            { id: "item-b", name: "Gadget" },
          ],
        },
      },
    },
    operationName: "catalogSearch",
    query: SEARCH_QUERY,
    variables: {},
    decodedParams: null,
  };
}

function restDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:11Z",
    phase: "browse",
    method: "GET",
    url: "https://example.com/inventory/api/v1/items?id=item-a",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { items: [{ id: "item-a", qty: 7 }] },
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
  // op A (facets, no results) captured three times — more often than op B —
  // so recurrenceScore prefers it as the emitted primary.
  writeFileSync(
    join(root, "graphql", "000-browse-facets-1.json"),
    JSON.stringify(graphqlFacetsCapture(1))
  );
  writeFileSync(
    join(root, "graphql", "001-browse-facets-2.json"),
    JSON.stringify(graphqlFacetsCapture(2))
  );
  writeFileSync(
    join(root, "graphql", "002-browse-facets-3.json"),
    JSON.stringify(graphqlFacetsCapture(3))
  );
  // op B (carries foldReturn.resultsPath's array) captured once.
  writeFileSync(
    join(root, "graphql", "003-browse-search.json"),
    JSON.stringify(graphqlSearchCapture())
  );
  writeFileSync(
    join(root, "graphql", "004-browse-drill.json"),
    JSON.stringify(restDrillDownCapture())
  );
}

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  const flow: Record<string, unknown> = {
    steps: [{ step: "browse the catalog" }],
    foldReturn: {
      endpointPattern: "/inventory/api/v1/items",
      resultsPath: "catalog.results.items",
      drillResultsPath: "items",
      joinFields: ["id"],
    },
  };
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

describe("recon-generate fold plan primary op differs from emitted primary — runtime e2e", () => {
  it("never resolves a fold plan against a different operation than the emitted primary", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-fold-primary-mismatch-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `fold-primary-mismatch-test-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).toContain("no fold plan resolved");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain("catalogSearch");
    expect(contract).not.toContain("results.items");
  }, 30_000);
});
