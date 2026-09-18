import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Acceptance test for the two changes to buildPaginatedGqlExecuteHttpBody:
 *
 * 1. The emitted payload schema declares an optional, caller-overridable
 *    `pageSize` numeric field (mirroring the existing `maxPages` field), and
 *    the emitted `PAGE_SIZE` initializer reads from `payload.pageSize` with
 *    the recon-captured page size as its fallback.
 * 2. The emitted loop breaks out as soon as a fetched page contributes no
 *    new distinct items, instead of trusting the server's reported `total`
 *    alone — so a total/distinct-id mismatch can't drive it to MAX_PAGES
 *    worth of wasted empty requests.
 *
 * Exercises the real CLI (`tsx recon-generate.ts`), matching
 * recon-generate-bounded-paging-maxpages-payload-field.test.ts.
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

/** 5 listing-style item objects, each with a bare `id` identity field. */
function makeListingPage(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `listing-${i}`,
    title: `Listing ${i}`,
  }));
}

/** A run dir whose primary operation's response exposes a total alongside a
 * skip+count pagination variable — the bounded-paging signal. */
function writePagedRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const listingSearch = gqlCapture({
    phase: "browse-the-listings",
    url: "https://www.listings-fixture.example.com/listings/graph",
    operationName: "listingSearch_Listings",
    query:
      "query listingSearch_Listings($pagination: PaginationInput) { search(pagination: $pagination) { total items { id title } } }",
    variables: { pagination: { count: 5, skip: 0 }, sort: "RELEVANCE" },
    responseBody: { search: { total: 15, items: makeListingPage(5) } },
  });

  writeFileSync(
    join(root, "graphql", "000-browse-the-listings-action.json"),
    JSON.stringify(listingSearch)
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

describe("recon-generate bounded paging: pageSize payload field and short-page loop stop", () => {
  it("declares a caller-overridable pageSize field defaulting to the captured page size, and stops the loop on a short/empty page instead of trusting total alone", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-pagesize-override-"));
    const runRoot = join(workDir, "run");
    writePagedRunDir(runRoot);

    const siteId = `pagesize-override-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // (1) The payload schema exposes an optional pageSize field...
    expect(contract).toMatch(/PayloadSchema\s*=\s*[\s\S]*?\.extend\(\{[\s\S]*?\}\)/);
    expect(contract).toMatch(/pageSize\??:\s*z\.(coerce\.)?number\(\)[\w.()]*\.optional\(\)/);

    // ...and PAGE_SIZE is sourced from it, falling back to the captured value.
    expect(contract).toContain("const PAGE_SIZE = payload.pageSize ?? 5;");
    expect(contract).not.toMatch(/const PAGE_SIZE = \d+;/);

    // (2) The loop stops as soon as a fetched page contributes no new items,
    // rather than trusting `total` alone — a mismatched total (e.g. total=437
    // but only 436 distinct ids ever exist) can't drive MAX_PAGES worth of
    // wasted empty requests.
    expect(contract).toContain("const sizeBeforePage = itemsById.size;");
    expect(contract).toContain("if (itemsById.size === sizeBeforePage) break;");
  }, 30_000);
});
