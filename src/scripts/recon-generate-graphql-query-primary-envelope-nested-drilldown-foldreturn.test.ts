import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Reproduces the reported failure end to end through the real
 * `recon-generate` CLI: a single-shot (non-paginated) GraphQL query-primary
 * whose response is wrapped in the realistic top-level `data` envelope, with
 * a declared `foldReturn.resultsPath` that drills 4 static segments deep
 * (`data.catalogSearch.results.groups`) before a wildcard segment flattens
 * across a nested array (`data.catalogSearch.results.groups.*.items`) — the
 * shape declared in the bug report but absent from every other fixture in
 * the repo, which either strip the `data` envelope entirely or use at most 2
 * static path segments before the wildcard. Before the fix, `resultsPath`
 * resolution silently failed to walk this deeper/enveloped shape, so the
 * flow-declared `foldReturn` was discarded without any diagnostic and the
 * emitted contract came out byte-identical to one generated with no
 * `foldReturn` at all.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const SEARCH_QUERY =
  "query catalogSearch { catalogSearch { results { groups { items { id title } } } } }";

function catalogSearchCapture(): unknown {
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
      data: {
        catalogSearch: {
          results: {
            groups: [
              { items: [{ id: "item-1", title: "Item One" }] },
              { items: [{ id: "item-2", title: "Item Two" }] },
            ],
          },
        },
      },
    },
    operationName: "catalogSearch",
    query: SEARCH_QUERY,
    variables: {},
    decodedParams: null,
  };
}

function itemDrillCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: "https://example.com/catalog/api/v1/detail?id=item-1",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ id: "item-1", weight: 12 }] },
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
    JSON.stringify(catalogSearchCapture())
  );
  writeFileSync(join(root, "graphql", "001-browse-drill.json"), JSON.stringify(itemDrillCapture()));
}

function writeFlowFile(siteOutDir: string, opts: { withFoldReturn: boolean }): void {
  mkdirSync(siteOutDir, { recursive: true });
  const flow: Record<string, unknown> = {
    steps: [{ step: "search the catalog" }],
  };
  if (opts.withFoldReturn) {
    flow.foldReturn = {
      endpointPattern: "/catalog/api/v1/detail",
      resultsPath: "data.catalogSearch.results.groups.*.items",
      drillResultsPath: "detail",
      joinFields: ["id"],
    };
  }
  writeFileSync(join(siteOutDir, "recon-flow.json"), JSON.stringify(flow));
}

let workDir: string | null = null;
let siteOutDirWith: string | null = null;
let siteOutDirWithout: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDirWith) rmSync(siteOutDirWith, { recursive: true, force: true });
  if (siteOutDirWithout) rmSync(siteOutDirWithout, { recursive: true, force: true });
  workDir = null;
  siteOutDirWith = null;
  siteOutDirWithout = null;
});

function run(runRoot: string, siteId: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

describe("GraphQL query-primary + data-enveloped nested-wildcard resultsPath + declared foldReturn — runtime e2e", () => {
  it("emits a materially different contract with vs. without the declared foldReturn", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-envelope-nested-diff-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteIdWith = `gql-envelope-nested-diff-with-run${process.pid}`;
    siteOutDirWith = join(REPO_ROOT, "src", "sites", siteIdWith);
    writeFlowFile(siteOutDirWith, { withFoldReturn: true });
    const resultWith = run(runRoot, siteIdWith);
    expect(resultWith.status, `${resultWith.stdout}\n${resultWith.stderr}`).toBe(0);
    const contractWith = readFileSync(join(siteOutDirWith, "contract.ts"), "utf8");

    const siteIdWithout = `gql-envelope-nested-diff-without-run${process.pid}`;
    siteOutDirWithout = join(REPO_ROOT, "src", "sites", siteIdWithout);
    writeFlowFile(siteOutDirWithout, { withFoldReturn: false });
    const resultWithout = run(runRoot, siteIdWithout);
    expect(resultWithout.status, `${resultWithout.stdout}\n${resultWithout.stderr}`).toBe(0);
    const contractWithout = readFileSync(join(siteOutDirWithout, "contract.ts"), "utf8");

    expect(contractWith.replace(new RegExp(siteIdWith, "g"), "SITE")).not.toBe(
      contractWithout.replace(new RegExp(siteIdWithout, "g"), "SITE")
    );
  }, 30_000);

  it("threads the drill endpoint and fold-merge loop into the emitted contract", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-envelope-nested-fold-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `gql-envelope-nested-fold-run${process.pid}`;
    siteOutDirWith = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDirWith, { withFoldReturn: true });

    const result = run(runRoot, siteId);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDirWith, "contract.ts"), "utf8");
    expect(contract).toContain("/catalog/api/v1/detail");
    // resultsPath crosses a wildcard ("results.groups.*.items"), so the
    // fold-merge loop is now a nested `for` (not a `.flatMap`-derived
    // `foldItems`) — see pathToFoldLoopLines's docstring.
    expect(contract).toContain("for (const g0 of");
    expect(contract).toContain("for (const item of g0.items) {");
  }, 30_000);

  it("never emits the 'no fold plan resolved' diagnostic for the resolvable declared foldReturn", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-envelope-nested-diag-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `gql-envelope-nested-diag-run${process.pid}`;
    siteOutDirWith = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDirWith, { withFoldReturn: true });

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).not.toContain("no fold plan resolved");
  }, 30_000);
});
