import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Reproduces the doc's explicit fallback ask end to end through the real
 * `recon-generate` CLI: a GraphQL query-primary whose `resultsPath` names a
 * NESTED WILDCARD array (`search.groups.*.items`) plus a declared
 * `foldReturn` whose `joinFields` name a key ("catalogId") that is absent
 * from every drill capture — a genuinely unresolvable fold, not merely one
 * excluded by an unrelated pagination check (see
 * recon-generate-graphql-paginated-foldreturn.test.ts, which covers the
 * RESOLVABLE case). `resolveFoldPlan`/`buildFoldPlanFromSpec`
 * (recon-generate.ts) can never find a join match for such a spec, so the
 * generic "no fold plan resolved" guard in `main()`
 * (recon-generate.ts:8999-9003) must still fire, and the emitted
 * contract.ts must omit the drill endpoint entirely rather than silently
 * folding nothing.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const SEARCH_QUERY =
  "query catalogSearch { catalogSearch { search { groups { items { id title } } } } }";

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
      catalogSearch: {
        search: {
          groups: [
            { items: [{ id: "item-1", title: "Item One" }] },
            { items: [{ id: "item-2", title: "Item Two" }] },
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

/** The drill response never exposes "catalogId" — only "id" — so the
 * declared foldReturn's joinFields can never resolve a join value. */
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

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  const flow: Record<string, unknown> = {
    steps: [{ step: "search the catalog" }],
    foldReturn: {
      endpointPattern: "/catalog/api/v1/detail",
      resultsPath: "search.groups.*.items",
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

describe("GraphQL query-primary + nested-wildcard resultsPath + unresolvable declared foldReturn — runtime e2e", () => {
  it("emits 'no fold plan resolved' and omits the drill endpoint when joinFields name a field absent from every drill capture", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-nested-wildcard-unresolvable-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `gql-nested-wildcard-unresolvable-run${process.pid}`;
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
