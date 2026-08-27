import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Reproduces the doc's explicit fallback ask for the data-enveloped,
 * 4-segment-deep nested-wildcard shape the bug report actually uses
 * (`data.<op>.results.<group>.*.<leaf>`, mirroring
 * recon-generate-graphql-query-primary-envelope-nested-drilldown-foldreturn.test.ts's
 * fixture) rather than the shallower 2-segment, non-enveloped shape covered
 * by recon-generate-graphql-nested-wildcard-foldreturn-unresolvable-warning.test.ts.
 * The declared `foldReturn.joinFields` names a field ("catalogId") that is
 * absent from every drill capture, so `buildFoldPlanFromSpec`'s join-
 * resolution step — not `resultsPath` resolution — is what fails, and the
 * generic "no fold plan resolved" guard in `main()` (recon-generate.ts)
 * must still fire rather than silently no-op.
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

/** The drill request/response never carries "item-1"/"item-2" (the primary
 * items' only string field, "id") or any "catalogId" value, so neither the
 * structural join heuristic (which matches ANY shared primary/drill field
 * value) nor the declared foldReturn's joinFields ("catalogId", absent from
 * every primary item and drill capture alike) can ever resolve a join. */
function itemDrillCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: "https://example.com/catalog/api/v1/detail?ref=opaque-token-9",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ ref: "opaque-token-9", weight: 12 }] },
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

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  const flow: Record<string, unknown> = {
    steps: [{ step: "search the catalog" }],
    foldReturn: {
      endpointPattern: "/catalog/api/v1/detail",
      resultsPath: "data.catalogSearch.results.groups.*.items",
      drillResultsPath: "detail",
      joinFields: ["catalogId"],
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

describe("GraphQL query-primary + data-enveloped deep nested-wildcard resultsPath + unresolvable declared foldReturn — runtime e2e", () => {
  it("emits 'no fold plan resolved' and omits the drill endpoint when joinFields name a field absent from every drill capture", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-envelope-nested-unresolvable-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `gql-envelope-nested-unresolvable-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).toContain("no fold plan resolved");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    // No silent partial fold: the drill endpoint never appears in the
    // generated contract at all.
    expect(contract).not.toContain("/catalog/api/v1/detail");
    expect(contract).not.toContain("foldItems");
  }, 30_000);
});
