import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Proves the actual root-cause fix this subtask exists for: a drill param
 * that lives ONLY on the ancestor group object (`groupId`), never on the
 * leaf item, threads into the emitted drill URL as `${g0.groupId}` — not
 * frozen as the first-captured literal `"g1"`. Every other fold test in this
 * suite either has no ancestor-only param to thread, or only proves the
 * nested-loop shape without a real ancestor field ever making it into a
 * rendered request.
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
          { groupId: "g1", items: [{ id: "item-a", name: "Widget" }] },
          { groupId: "g2", items: [{ id: "item-c", name: "Sprocket" }] },
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
    url: "https://example.com/availability/api/v1/groups/g1/items/item-a/details",
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

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  const flow: Record<string, unknown> = {
    steps: [{ step: "search for groups" }],
    foldReturn: {
      endpointPattern: "/availability/api/v1/groups/",
      resultsPath: "search.groups.*.items",
      drillResultsPath: "details",
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

describe("recon-generate drill-down fold — ancestor-only groupId threading runtime e2e", () => {
  it("threads a group-only groupId into the drill URL as an ancestor accessor, not a frozen literal", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-ancestor-thread-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `ancestor-thread-test-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;
    expect(result.status, out).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("for (const g0 of");
    expect(contract).toContain("g0.groupId");
    expect(contract).not.toContain("/groups/g1/");
  }, 30_000);
});
