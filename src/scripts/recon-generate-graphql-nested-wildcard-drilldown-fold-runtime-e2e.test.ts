import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Mirrors recon-generate-drilldown-fold-return-graphql-get-drill-runtime-e2e.test.ts
 * but gives the GraphQL query-primary a two-level nested array
 * (`search.groups.*.items`), matching the doc's reported `cruises.*.sailings`
 * shape. Proves the fix resolves a fold plan through a nested wildcard
 * resultsPath declared on a single-primary GraphQL flow — not just the flat
 * resultsPath case, and not just the structural-heuristic multi-step path
 * already covered by recon-generate-fold-return.test.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const SEARCH_QUERY = "query searchGroups { search { groups { items { id name } } } }";

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
      search: {
        groups: [
          {
            items: [
              { id: "item-a", name: "Widget" },
              { id: "item-b", name: "Gadget" },
            ],
          },
          {
            items: [
              { id: "item-c", name: "Sprocket" },
              { id: "item-d", name: "Cog" },
            ],
          },
        ],
      },
    },
    operationName: "searchGroups",
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
    url: "https://example.com/availability/api/v1/details?id=item-a",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { details: [{ id: "item-a", qty: 3 }] },
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
    steps: [{ step: "search for groups" }],
  };
  if (opts.withFoldReturn) {
    flow.foldReturn = {
      endpointPattern: "/availability/api/v1/details",
      resultsPath: "search.groups.*.items",
      drillResultsPath: "details",
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

describe("recon-generate GraphQL-primary + nested-wildcard foldReturn — runtime e2e", () => {
  it("resolves a fold plan through a nested wildcard resultsPath and emits a flatMap over the drill endpoint", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-nested-wildcard-fold-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `gql-nested-wildcard-fold-test-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir, { withFoldReturn: true });

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).not.toContain("no fold plan resolved");

    const contractWith = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contractWith).toContain("/availability/api/v1/details");
    expect(contractWith).toContain("for (const g0 of");
    expect(contractWith).toContain("for (const item of g0.items)");

    rmSync(siteOutDir, { recursive: true, force: true });
    writeFlowFile(siteOutDir, { withFoldReturn: false });

    const resultWithout = run(runRoot, siteId);
    expect(resultWithout.status, `${resultWithout.stdout}\n${resultWithout.stderr}`).toBe(0);

    const contractWithout = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contractWithout).not.toContain("/availability/api/v1/details");

    expect(contractWith).not.toEqual(contractWithout);
  }, 30_000);
});
