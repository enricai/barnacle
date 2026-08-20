import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Reproduces the reported bug shape directly: the primary GraphQL operation
 * declares two filter-shaped variables (`$filters`, `$qualifiers`), and
 * every capture of that operation leaves both unpopulated, so the generated
 * executeHttp would silently replay the captured frozen value instead of
 * wiring the caller's payload. selectPrimaryGraphQLOperation's
 * unpopulatedDeclaredVariables detection (bugfix-002/bugfix-003) must
 * surface a generation-time WARN naming the operation and both variables,
 * and must NOT fire when at least one capture demonstrates the filter path.
 * Mirrors recon-generate-empty-replays-warn.test.ts's and
 * recon-generate-bootstrap-flow-warn.test.ts's spawnSync/mkdtempSync scaffold.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const QUERY =
  "query catalogSearch_Items($filters: String, $qualifiers: String) { catalogSearch(filters: $filters, qualifiers: $qualifiers) { items { id name } } }";

function gqlCapture(index: number, variables: Record<string, unknown> | null) {
  return {
    timestamp: `2026-01-01T00:00:0${index}Z`,
    phase: "browse-the-catalog",
    method: "POST",
    url: "https://www.catalog-fixture.example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: QUERY, variables }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      catalogSearch: { items: Array.from({ length: 5 }, (_, i) => ({ id: i, name: `Item ${i}` })) },
    },
    operationName: "catalogSearch_Items",
    query: QUERY,
    variables,
    decodedParams: null,
  };
}

/** Every capture of the sole primary operation leaves both declared filter params unset. */
function writeUnfilteredRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(
    join(root, "graphql", "000-browse-the-catalog-action.json"),
    JSON.stringify(gqlCapture(0, { filters: undefined, qualifiers: null }))
  );
  writeFileSync(
    join(root, "graphql", "001-browse-the-catalog-action.json"),
    JSON.stringify(gqlCapture(1, { filters: "", qualifiers: undefined }))
  );
  writeFileSync(
    join(root, "replays", "000-browse-the-catalog-action.json"),
    JSON.stringify(gqlCapture(0, null))
  );
}

/** Control: identical shape, but one capture demonstrates both declared variables were wired. */
function writeFilteredRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(
    join(root, "graphql", "000-browse-the-catalog-action.json"),
    JSON.stringify(gqlCapture(0, { filters: undefined, qualifiers: null }))
  );
  writeFileSync(
    join(root, "graphql", "001-browse-the-catalog-action.json"),
    JSON.stringify(gqlCapture(1, { filters: "category:kitchen", qualifiers: "in-stock" }))
  );
  writeFileSync(
    join(root, "replays", "000-browse-the-catalog-action.json"),
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

describe("recon-generate CLI — primary-capture-is-unfiltered warning", () => {
  it("warns naming the primary operation and every unpopulated declared filter variable", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-primary-capture-unfiltered-"));
    const runRoot = join(workDir, "run");
    writeUnfilteredRunDir(runRoot);

    const siteId = `primary-capture-unfiltered-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).toContain("catalogSearch_Items");
    expect(out).toContain("filters");
    expect(out).toContain("qualifiers");
    expect(out).toContain("will replay the captured frozen value");
  }, 30_000);

  it("does not warn when at least one capture demonstrates the filter path (control)", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-primary-capture-filtered-"));
    const runRoot = join(workDir, "run");
    writeFilteredRunDir(runRoot);

    const siteId = `primary-capture-filtered-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).not.toContain("will replay the captured frozen value");
  }, 30_000);
});
