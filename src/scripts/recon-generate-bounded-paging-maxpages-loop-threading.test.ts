import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Proves the paging loop's bound is actually wired to the payload-sourced
 * `maxPages` override rather than a frozen numeric literal: the emitted
 * `MAX_PAGES` initializer must read from `payload.maxPages`, and the loop's
 * comparison operand (recon-generate.ts:4488) must be that same identifier,
 * unchanged in shape. The sibling unpaginated fixture proves the untouched
 * no-signal code path stays completely free of any maxPages/MAX_PAGES text.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function gqlCapture(overrides: {
  phase: string;
  url: string;
  operationName: string | null;
  query: string | null;
  variables: Record<string, unknown> | null;
  responseBody: unknown;
}) {
  return {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: overrides.phase,
    method: "POST",
    url: overrides.url,
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

/** 5 catalog-style item objects, each with a bare `id` identity field. */
function makeCatalogPage(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    title: `Item ${i}`,
  }));
}

/** A run dir whose primary operation's response exposes a total alongside a
 * skip+count pagination variable — the bounded-paging signal. */
function writePagedRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const catalogSearch = gqlCapture({
    phase: "browse-the-catalog",
    url: "https://www.catalog-fixture.example.com/catalog/graph",
    operationName: "catalogSearch_Catalog",
    query:
      "query catalogSearch_Catalog($pagination: PaginationInput) { search(pagination: $pagination) { total items { id title } } }",
    variables: { pagination: { count: 5, skip: 0 }, sort: "RELEVANCE" },
    responseBody: { search: { total: 15, items: makeCatalogPage(5) } },
  });

  writeFileSync(
    join(root, "graphql", "000-browse-the-catalog-action.json"),
    JSON.stringify(catalogSearch)
  );
}

/** A sibling run dir whose primary operation has a pagination variable but no
 * total/count field in the response — no bounded-paging signal. */
function writeUnpagedRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const catalogSearch = gqlCapture({
    phase: "browse-the-catalog",
    url: "https://www.catalog-fixture.example.com/catalog/graph",
    operationName: "catalogSearch_Catalog",
    query:
      "query catalogSearch_Catalog($pagination: PaginationInput) { search(pagination: $pagination) { items { id title } } }",
    variables: { pagination: { count: 5, skip: 0 }, sort: "RELEVANCE" },
    responseBody: { search: { items: makeCatalogPage(5) } },
  });

  writeFileSync(
    join(root, "graphql", "000-browse-the-catalog-action.json"),
    JSON.stringify(catalogSearch)
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

describe("recon-generate bounded paging: MAX_PAGES loop bound is threaded from payload.maxPages", () => {
  it("wires the loop's bound identifier to payload.maxPages instead of a frozen literal", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-maxpages-loop-threading-"));
    const runRoot = join(workDir, "run");
    writePagedRunDir(runRoot);

    const siteId = `maxpages-loop-threading-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The bound is declared from the payload, not a frozen numeric literal.
    expect(contract).toContain("const MAX_PAGES = payload.maxPages ?? 50;");
    expect(contract).not.toMatch(/const MAX_PAGES = \d+;/);

    // The loop's comparison operand is the SAME identifier the initializer
    // line declares — no dangling second literal reintroduced elsewhere.
    expect(contract).toContain(
      "for (let pageIndex = 1; pageIndex < MAX_PAGES && itemsById.size < total; pageIndex++)"
    );

    // The pre-existing identity-merge and truncation-total-rewrite behavior
    // is unchanged in shape by this parameterization.
    expect(contract).toContain("itemsById.set(String(item.id), item);");
    expect(contract).toContain("const truncated = itemsById.size < total;");
    expect(contract).toContain("total: truncated ? itemsById.size : withItems.search.total");
  }, 30_000);
});

describe("recon-generate bounded paging: no pagination signal stays free of maxPages", () => {
  it("emits no MAX_PAGES/maxPages text anywhere when there is no pagination signal", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-maxpages-no-signal-"));
    const runRoot = join(workDir, "run");
    writeUnpagedRunDir(runRoot);

    const siteId = `maxpages-no-signal-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    expect(contract).not.toContain("MAX_PAGES");
    expect(contract).not.toContain("maxPages");
  }, 30_000);
});
