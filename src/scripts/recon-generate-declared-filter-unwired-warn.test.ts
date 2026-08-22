import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { SitePlugin } from "@/site-plugin";

/**
 * When selectPrimaryGraphQLOperation (bugfix-002) reports a declared filter
 * variable that no capture ever populates, main() must warn at generation
 * time — otherwise the generated executeHttp silently replays the captured
 * frozen value and the caller's payload for that field is structurally
 * ignored. Exercises the real CLI (`tsx recon-generate.ts`), matching
 * recon-generate-empty-replays-warn.test.ts's pattern.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const QUERY =
  "query catalogSearch_Items($filters: String) { catalogSearch(filters: $filters) { items { id name } } }";

function gqlCapture(index: number, variables: Record<string, unknown> | null) {
  return {
    timestamp: `2024-01-01T00:00:0${index}Z`,
    phase: "browse",
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: QUERY, variables }),
    responseHeaders: {},
    responseBody: {
      catalogSearch: { items: Array.from({ length: 5 }, (_, i) => ({ id: i, name: `Item ${i}` })) },
    },
    operationName: "catalogSearch_Items",
    query: QUERY,
    variables,
    decodedParams: null,
  };
}

/** 2+ captures of one read-only operation whose $filters is never populated. */
function writeUnwiredRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(
    join(root, "graphql", "000-browse-action.json"),
    JSON.stringify(gqlCapture(0, { filters: undefined }))
  );
  writeFileSync(
    join(root, "graphql", "001-browse-action.json"),
    JSON.stringify(gqlCapture(1, { filters: null }))
  );
  writeFileSync(
    join(root, "replays", "000-browse-action.json"),
    JSON.stringify(gqlCapture(0, null))
  );
}

/** Control: the same shape, but $filters IS populated on one capture. */
function writeWiredRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(
    join(root, "graphql", "000-browse-action.json"),
    JSON.stringify(gqlCapture(0, { filters: "category:kitchen" }))
  );
  writeFileSync(
    join(root, "graphql", "001-browse-action.json"),
    JSON.stringify(gqlCapture(1, { filters: null }))
  );
  writeFileSync(
    join(root, "replays", "000-browse-action.json"),
    JSON.stringify(gqlCapture(0, null))
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

function run(runRoot: string, siteId: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

/** The generated contract module exports exactly one `<camel>Plugin`; find it by name shape. */
async function loadBodySchema(siteOutDir: string): Promise<SitePlugin["meta"]["bodySchema"]> {
  const contractPath = join(siteOutDir, "contract.ts");
  const contractModule: Record<string, unknown> = await import(
    /* @vite-ignore */ contractPath
  );
  const pluginExportName = Object.keys(contractModule).find((name) => name.endsWith("Plugin"));
  if (!pluginExportName) throw new Error(`no *Plugin export found in ${contractPath}`);
  return (contractModule[pluginExportName] as SitePlugin).meta.bodySchema;
}

/**
 * A flow step whose explicit `payloadField` names the declared GraphQL
 * variable's PascalCase field, so `emitBrowserFlowTs`'s payloadFieldNames
 * accumulator (and therefore emitContractTs's merged extend) actually
 * contains that field — otherwise the generated contract never declares it
 * at all, and there is nothing to assert optional/required about.
 */
function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify([{ step: "select the category filters", payloadField: "Filters" }])
  );
}

describe("recon-generate declared-filter-unwired warning", () => {
  it("warns naming the operation and the unwired variable when no capture populates it", async () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-unwired-filter-"));
    const runRoot = join(workDir, "run");
    writeUnwiredRunDir(runRoot);

    const siteId = `unwired-filter-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).toContain("catalogSearch_Items");
    expect(out).toContain("filters");
    expect(out).toContain("will replay the captured frozen value");

    // The unwired declared variable's field has no wiring target in
    // executeHttp, so the caller must be free to omit it from the payload.
    const bodySchema = await loadBodySchema(siteOutDir);
    expect(bodySchema.safeParse({ query: "kitchen" }).success).toBe(true);
  }, 30_000);

  it("does not warn when the declared variable is populated on at least one capture (control)", async () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-wired-filter-"));
    const runRoot = join(workDir, "run");
    writeWiredRunDir(runRoot);

    const siteId = `wired-filter-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).not.toContain("will replay the captured frozen value");

    // A wired sibling field DOES have a wiring target, so it stays required —
    // omitting it must fail safeParse instead of silently passing.
    const bodySchema = await loadBodySchema(siteOutDir);
    expect(bodySchema.safeParse({ query: "kitchen" }).success).toBe(false);
    expect(bodySchema.safeParse({ query: "kitchen", Filters: "category:kitchen" }).success).toBe(
      true
    );
  }, 30_000);
});
