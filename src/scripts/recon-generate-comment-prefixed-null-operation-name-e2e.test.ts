import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Isolates the comment-stripping defect on its own: exactly one GraphQL
 * capture carries the operation under test, with no ranking ambiguity at
 * all — the only other capture is an unrelated, unambiguously-lower-scoring
 * decoy needed solely so `isGraphQL` classifies the run as GraphQL. A
 * failure here can only mean `parsedOperationName` failed to strip a
 * leading `#`-comment line, not a regression in
 * `selectPrimaryGraphQLOperation`'s scoring.
 *
 * Mirrors recon-generate-gql-null-operation-name-e2e.test.ts's spawnSync-the-
 * real-CLI pattern, with the query string changed to add a leading `#
 * FetchWidgetCatalog` comment line above the named `query` signature.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — comment-prefixed query with null operationName", () => {
  it("strips the leading `#`-comment line and emits the parsed query name, not the fabricated placeholder", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-comment-null-op-name-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // A second, unrelated capture with a real top-level operationName so
    // `isGraphQL` classifies the whole capture set as GraphQL — mirroring a
    // real recon run where some requests are named and some are sent as
    // inline query documents. It carries no ranking ambiguity of its own: a
    // distinct operation, a tiny response, so it can never outscore the
    // capture under test in `selectPrimaryGraphQLOperation`.
    const decoyCapture = {
      timestamp: "2026-08-19T19:15:00.000Z",
      phase: "search",
      method: "POST",
      url: "https://www.widget-fixture.example.com/graphql",
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({ variables: {} }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { session: { id: "xyz" } },
      operationName: "SessionInit",
      query: "query SessionInit { session { id } }",
      variables: {},
      decodedParams: null,
    };
    writeFileSync(join(capturesDir, "000-search-action.json"), JSON.stringify(decoyCapture));

    const capture = {
      timestamp: "2026-08-19T19:16:15.000Z",
      phase: "search",
      method: "POST",
      url: "https://www.widget-fixture.example.com/graphql",
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({
        variables: { category: "outdoor" },
      }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: {
        widgets: Array.from({ length: 50 }, (_, i) => ({ id: `widget-${i}` })),
      },
      operationName: null,
      query:
        "# FetchWidgetCatalog\nquery FetchWidgetCatalog($category: String) { widgets(category: $category) { id } }",
      variables: { category: "outdoor" },
      decodedParams: null,
    };
    writeFileSync(join(capturesDir, "001-search-action.json"), JSON.stringify(capture));

    const siteId = `gql-comment-null-op-name-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contractPath = join(siteOutDir, "contract.ts");
    expect(existsSync(contractPath)).toBe(true);
    const contract = readFileSync(contractPath, "utf8");

    expect(contract).toContain('getGql(context.baseUrl)("FetchWidgetCatalog"');
    expect(contract).not.toMatch(/Search"/);
    expect(contract).not.toContain("{ q: payload.query }");
  }, 60_000);
});
