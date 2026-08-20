import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Acceptance test for the submitStep-declared, zero-mutation flow whose
 * winning own-backend capture carries `operationName: null`: once
 * host-provenance selection reaches this path (recon-generate-graphql-readonly-e2e.test.ts's
 * "flow declares submitStep:true" case), the emitted contract.ts must still
 * resolve the winner's real operation name from the inline named query
 * document, not fall back to `firstGraphQLQuery`'s verbatim/anonymous
 * handling.
 *
 * Exercises the real CLI (`tsx recon-generate.ts`), matching
 * recon-generate-graphql-readonly-e2e.test.ts, since the read-only selection
 * gate lives inside the un-exported `main`.
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
 * Same shape as recon-generate-graphql-readonly-e2e.test.ts's
 * writeSubmitStepMutationFreeRunDir, except the winning own-backend capture's
 * `operationName` is null and its `query` is an inline named document
 * (`FilteredSearch`) rather than sharing the third-party decoy's name — the
 * winner must be resolved by body-parsing, not by the decoy's operationName
 * or a fabricated/anonymous label.
 */
function writeSubmitStepNullOperationRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const thirdPartyQuery = gqlCapture({
    phase: "open-the-metro-filter",
    url: "https://gql.third-party-tracker.example.net/collect/graph",
    operationName: "listingSearch_Listings",
    query: "query listingSearch_Listings { trackedEvents { id } }",
    variables: null,
    responseLength: 2048,
  });
  for (let i = 0; i < 16; i++) {
    writeFileSync(
      join(root, "graphql", `000-open-the-metro-filter-tracker-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(thirdPartyQuery)
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

describe("recon-generate: submitStep-declared flow whose winning own-backend capture has operationName: null", () => {
  it("resolves the emitted operation name from the body-parsed query name, not a fabricated or anonymous label", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-submitstep-readonly-null-op-e2e-"));
    const runRoot = join(workDir, "run");
    writeSubmitStepNullOperationRunDir(runRoot);

    const siteId = `submitstep-readonly-null-op-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "apply the metro filter", payloadField: "metro", submitStep: true }],
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

    // The winner's real, body-parsed operation name is emitted as the
    // getGql() call site's operationName literal.
    expect(contract).toContain('"FilteredSearch"');
    expect(contract).toContain("listings(metro: $metro)");

    // Never the decoy's shared-but-wrong operationName, and never a
    // fabricated/anonymous label in its place.
    expect(contract).not.toContain("trackedEvents");
    expect(contract).not.toMatch(/getGql\([^)]*\)\("listingSearch_Listings"/);
    expect(contract).not.toMatch(/getGql\([^)]*\)\("\(anonymous\)"/);
    expect(contract).not.toMatch(/getGql\([^)]*\)\(null/);
  }, 30_000);
});
