import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Acceptance test for the caller-overridable `maxPages` payload field: driving
 * the real CLI against a captured primary operation with a detected bounded-
 * paging signal asserts the emitted `${Pascal}PayloadSchema` extend block
 * declares an optional `maxPages` numeric field via the same
 * `payloadFieldNames`/`addExtendField` merged-extension mechanism other
 * discovered fields use. A sibling capture with no pagination signal asserts
 * the field is absent.
 *
 * Exercises the real CLI (`tsx recon-generate.ts`), matching
 * recon-generate-graphql-paginated-fetch-loop.test.ts, since pagination
 * detection lives inside the un-exported `main`.
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

/** 5 product-style item objects, each with a bare `id` identity field. */
function makeProductPage(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `prod-${i}`,
    title: `Product ${i}`,
  }));
}

/** A run dir whose primary operation's response exposes a total alongside a
 * skip+count pagination variable — the bounded-paging signal. */
function writePagedRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const productSearch = gqlCapture({
    phase: "browse-the-products",
    url: "https://www.products-fixture.example.com/products/graph",
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

/** A sibling run dir whose primary operation has a pagination variable but no
 * total/count field in the response — no bounded-paging signal. */
function writeUnpagedRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const productSearch = gqlCapture({
    phase: "browse-the-products",
    url: "https://www.products-fixture.example.com/products/graph",
    operationName: "productSearch_Products",
    query:
      "query productSearch_Products($pagination: PaginationInput) { search(pagination: $pagination) { items { id title } } }",
    variables: { pagination: { count: 5, skip: 0 }, sort: "RELEVANCE" },
    responseBody: { search: { items: makeProductPage(5) } },
  });

  writeFileSync(
    join(root, "graphql", "000-browse-the-products-action.json"),
    JSON.stringify(productSearch)
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

describe("recon-generate bounded-paging maxPages payload field: total/count signal present", () => {
  it("declares an optional, caller-overridable maxPages numeric field on the payload schema", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-maxpages-payload-field-"));
    const runRoot = join(workDir, "run");
    writePagedRunDir(runRoot);

    const siteId = `maxpages-payload-field-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    expect(contract).toMatch(/PayloadSchema\s*=\s*[\s\S]*?\.extend\(\{[\s\S]*?\}\)/);
    expect(contract).toMatch(/maxPages\??:\s*z\.(coerce\.)?number\(\)[\w.()]*\.optional\(\)/);
  }, 30_000);
});

describe("recon-generate bounded-paging maxPages payload field: no total/count signal", () => {
  it("declares no maxPages field when no pagination signal is detected", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-no-maxpages-payload-field-"));
    const runRoot = join(workDir, "run");
    writeUnpagedRunDir(runRoot);

    const siteId = `no-maxpages-payload-field-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    expect(contract).not.toContain("maxPages");
  }, 30_000);
});
