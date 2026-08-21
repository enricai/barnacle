import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Acceptance test for the case recon-generate-submitstep-readonly-null-operation-association-e2e.test.ts
 * does not cover: the own-backend host itself serves TWO distinct real
 * GraphQL operations on the same endpoint, not just an operationName-null
 * facet query and a same-named third-party decoy. One operation is the
 * winning facet-bearing query sent with `operationName: null` (resolved by
 * body-parsing its inline name); the other is a named, non-facet metadata
 * query on the same own-backend host with more captures. The facet-bearing
 * query must still win primary selection, and the metadata query's name and
 * field shape must be entirely absent from the emitted contract.
 *
 * Exercises the real CLI (`tsx recon-generate.ts`), matching
 * recon-generate-graphql-readonly-e2e.test.ts, since selection lives inside
 * the un-exported `main`.
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
  responseLength: number;
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
    responseBody: { pad: "x".repeat(Math.max(0, overrides.responseLength - '{"pad":""}'.length)) },
    operationName: overrides.operationName,
    query: overrides.query,
    variables: overrides.variables,
    decodedParams: null,
  };
}

/**
 * Both operations live on the same own-backend host and endpoint path. The
 * metadata query is a real, named, non-facet operation with more captures
 * and a larger average response than the facet query, so recurrence/size
 * alone would favor it -- only the facet-spliceable tiering in
 * selectPrimaryGraphQLOperation should keep it from winning.
 */
function writeNullOperationVsUnrelatedNamedQueryRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const metadataQuery = gqlCapture({
    phase: "open-the-metro-filter",
    url: "https://www.own-backend-fixture.example.com/x/graph",
    operationName: "FilterOptionsMetadata",
    query: "query FilterOptionsMetadata { filterOptions { categories { id label } } }",
    variables: null,
    responseLength: 65536,
  });
  for (let i = 0; i < 20; i++) {
    writeFileSync(
      join(
        root,
        "graphql",
        `000-open-the-metro-filter-metadata-${String(i).padStart(2, "0")}.json`
      ),
      JSON.stringify(metadataQuery)
    );
  }

  const facetQuery = (metro: string) =>
    gqlCapture({
      phase: "open-the-metro-filter",
      url: "https://www.own-backend-fixture.example.com/x/graph",
      operationName: null,
      query: "query FilteredSearch($metro: String) { listings(metro: $metro) { id name } }",
      variables: { metro },
      responseLength: 61440,
    });
  const metros = ["AUSTIN", "DENVER", "SEATTLE", "BOSTON", "MIAMI", "PHOENIX"];
  metros.forEach((metro, i) => {
    writeFileSync(
      join(root, "graphql", `100-open-the-metro-filter-facet-${i}.json`),
      JSON.stringify(facetQuery(metro))
    );
  });
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate: operationName-null facet query vs. an unrelated named non-facet query on the same own-backend endpoint", () => {
  it("selects the facet-bearing null-operation query as primary, not the unrelated named metadata query", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-null-op-vs-unrelated-named-e2e-"));
    const runRoot = join(workDir, "run");
    writeNullOperationVsUnrelatedNamedQueryRunDir(runRoot);

    const siteId = `null-op-vs-unrelated-named-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "apply the metro filter", payloadField: "metro" }],
        ownBackendHostnames: ["www.own-backend-fixture.example.com"],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The winner's real, body-parsed operation name and real facet variable
    // wiring are emitted as the getGql() call site's arguments.
    expect(contract).toContain('"FilteredSearch"');
    expect(contract).toContain("listings(metro: $metro)");

    // Never the unrelated named query's operation name or field shape, even
    // though it shares the winner's endpoint and outnumbers it in captures.
    expect(contract).not.toContain("FilterOptionsMetadata");
    expect(contract).not.toContain("filterOptions");
    expect(contract).not.toContain("categories");
    expect(contract).not.toMatch(/getGql\([^)]*\)\("FilterOptionsMetadata"/);
  }, 30_000);
});
