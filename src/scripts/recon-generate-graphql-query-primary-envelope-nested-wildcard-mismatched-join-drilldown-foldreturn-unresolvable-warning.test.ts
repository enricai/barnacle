import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Combines the data-enveloped 2-level nested-wildcard resultsPath
 * (`data.op.results.groups.*.items`, mirroring
 * recon-generate-graphql-query-primary-envelope-nested-wildcard-mismatched-join-drilldown-fold-runtime-e2e.test.ts's
 * fixture) with a drill capture whose request AND response both omit the
 * declared `foldReturn.joinFields` entirely (unlike that test's
 * mismatched-join fixture, where the drill response still echoes the
 * declared join field under a different request key). No existing test
 * exercises this exact combined shape's failure path, so the generic
 * "no fold plan resolved" guard in `main()` (recon-generate.ts) must still
 * fire rather than silently no-op.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const CATALOG_SEARCH_QUERY =
  "query catalogSearch { catalogSearch { data { op { results { groups { id items { id sku title } } } } } } }";

function envelopeNestedGraphqlSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: "https://api.example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: CATALOG_SEARCH_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      data: {
        op: {
          results: {
            groups: [
              {
                id: "group-1",
                items: [
                  { id: "item-1", sku: "SKU-1", title: "Widget" },
                  { id: "item-2", sku: "SKU-2", title: "Gadget" },
                ],
              },
            ],
          },
        },
      },
    },
    operationName: "catalogSearch",
    query: CATALOG_SEARCH_QUERY,
    variables: {},
    decodedParams: null,
  };
}

/** Unlike the mismatched-join fixture (which still echoes the declared
 * joinFields, "id", in its response under a different request key), this
 * drill capture omits "id" from BOTH the request and the response — so
 * neither the structural join heuristic nor the declared foldReturn's
 * joinFields can ever resolve a join. */
function unjoinableDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: "https://api.example.com/listings/api/v1/details?ref=opaque-token-7",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ ref: "opaque-token-7", region: "north" }] },
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
    JSON.stringify(envelopeNestedGraphqlSearchCapture())
  );
  writeFileSync(
    join(root, "graphql", "001-browse-drill.json"),
    JSON.stringify(unjoinableDrillDownCapture())
  );
}

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  const flow: Record<string, unknown> = {
    steps: [{ step: "search the catalog" }],
    foldReturn: {
      endpointPattern: "/listings/api/v1/details",
      resultsPath: "data.op.results.groups.*.items",
      drillResultsPath: "detail",
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

describe("GraphQL query-primary + data-enveloped nested-wildcard resultsPath + unresolvable declared foldReturn (mismatched drill fields) — runtime e2e", () => {
  it("emits 'no fold plan resolved' and omits the drill endpoint when the declared joinFields are absent from every drill capture", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-envelope-nested-mismatch-unresolvable-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `gql-envelope-nested-mismatch-unresolvable-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).toContain("no fold plan resolved");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    // No silent partial fold: the drill endpoint never appears in the
    // generated contract at all.
    expect(contract).not.toContain("/listings/api/v1/details");
    expect(contract).not.toContain("foldItems");
  }, 30_000);
});
