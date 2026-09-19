import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Proves the emitted `PAGE_SIZE` default prefers a consumer-declared
 * `--value-constraints` `max` for the detected pagination count-key field
 * over whatever page size recon happened to capture, for both the GraphQL
 * and REST bounded-paging loop emission paths (both funnel through the same
 * buildPaginatedFetchLoopExecuteHttpBody after bugfix-001's unification).
 *
 * A control case in each describe block proves that with no declared
 * constraint the emitted default stays byte-identical to today's
 * captured-value behavior — the caller-supplied `payload.pageSize ??`
 * override and the no-constraint default must both survive unchanged.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function gqlCapture(overrides: {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
  responseBody: unknown;
}) {
  return {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: "browse-the-products",
    method: "POST",
    url: "https://www.products-fixture.example.com/products/graph",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: "{}",
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: overrides.operationName,
    query: overrides.query,
    variables: overrides.variables,
    decodedParams: null,
  };
}

function restCapture(overrides: {
  variables: Record<string, unknown>;
  responseBody: unknown;
}) {
  return {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: "browse-the-products",
    method: "GET",
    url: "https://www.products-fixture.example.com/api/products/search",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: null,
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: overrides.variables,
    decodedParams: null,
  };
}

/** 5 product-style item objects, each with a bare `id` identity field. */
function makeProductPage(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `prod-${i}`,
    title: `Product ${i}`,
  }));
}

function writeGqlPagedRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const productSearch = gqlCapture({
    operationName: "productSearch_Products",
    query:
      "query productSearch_Products($pagination: PaginationInput) { search(pagination: $pagination) { total items { id title } } }",
    variables: { pagination: { count: 5, skip: 0 }, sort: "RELEVANCE" },
    responseBody: { search: { total: 15, items: makeProductPage(5) } },
  });

  writeFileSync(
    join(root, "graphql", "000-browse-the-products-action.json"),
    JSON.stringify(productSearch)
  );
}

function writeRestPagedRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const productSearch = restCapture({
    variables: { skip: 0, count: 5, sort: "RELEVANCE" },
    responseBody: { total: 15, items: makeProductPage(5) },
  });

  writeFileSync(
    join(root, "graphql", "000-browse-the-products-action.json"),
    JSON.stringify(productSearch)
  );
}

function writeValueConstraintsModule(dir: string, fieldName: string, max: number): string {
  const constraintsPath = join(dir, "value-constraints.mjs");
  writeFileSync(
    constraintsPath,
    `export const valueConstraints = {\n  ${fieldName}: { max: ${max} },\n};\n`
  );
  return constraintsPath;
}

function runGenerate(runRoot: string, siteId: string, extraArgs: string[]) {
  return spawnSync(
    TSX_BIN,
    [
      GENERATE_SCRIPT,
      "--site-id",
      siteId,
      "--run-dir",
      runRoot,
      "--emit",
      "ts",
      "--force",
      ...extraArgs,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

let workDir: string | null = null;
const siteOutDirs: string[] = [];

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  for (const dir of siteOutDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  workDir = null;
});

describe("recon-generate CLI — PAGE_SIZE default prefers a declared value-constraint max (GraphQL)", () => {
  it("uses the declared max instead of the captured page size when --value-constraints declares one for the count-key field", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-pagination-value-constraint-gql-"));
    const runRoot = join(workDir, "run");
    writeGqlPagedRunDir(runRoot);
    const constraintsPath = writeValueConstraintsModule(workDir, "count", 50);

    const siteId = `pagination-value-constraint-gql-test-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    siteOutDirs.push(siteOutDir);

    const result = runGenerate(runRoot, siteId, ["--value-constraints", constraintsPath]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("const PAGE_SIZE = payload.pageSize ?? 50;");
    expect(contract).not.toContain("const PAGE_SIZE = payload.pageSize ?? 5;");
  }, 30_000);

  it("with no declared constraint, emits today's captured-value default byte-identical", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-pagination-value-constraint-gql-none-"));
    const runRoot = join(workDir, "run");
    writeGqlPagedRunDir(runRoot);

    const siteId = `pagination-value-constraint-gql-none-test-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    siteOutDirs.push(siteOutDir);

    const result = runGenerate(runRoot, siteId, []);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("const PAGE_SIZE = payload.pageSize ?? 5;");
  }, 30_000);
});

describe("recon-generate CLI — PAGE_SIZE default prefers a declared value-constraint max (REST)", () => {
  it("uses the declared max instead of the captured page size when --value-constraints declares one for the count-key field", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-pagination-value-constraint-rest-"));
    const runRoot = join(workDir, "run");
    writeRestPagedRunDir(runRoot);
    const constraintsPath = writeValueConstraintsModule(workDir, "count", 50);

    const siteId = `pagination-value-constraint-rest-test-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    siteOutDirs.push(siteOutDir);

    const result = runGenerate(runRoot, siteId, ["--value-constraints", constraintsPath]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("const PAGE_SIZE = payload.pageSize ?? 50;");
    expect(contract).not.toContain("const PAGE_SIZE = payload.pageSize ?? 5;");
  }, 30_000);

  it("with no declared constraint, emits today's captured-value default byte-identical", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-pagination-value-constraint-rest-none-"));
    const runRoot = join(workDir, "run");
    writeRestPagedRunDir(runRoot);

    const siteId = `pagination-value-constraint-rest-none-test-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    siteOutDirs.push(siteOutDir);

    const result = runGenerate(runRoot, siteId, []);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("const PAGE_SIZE = payload.pageSize ?? 5;");
  }, 30_000);
});
