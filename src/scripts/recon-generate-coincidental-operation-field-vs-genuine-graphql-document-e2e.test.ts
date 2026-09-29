import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * `isGraphQL()`'s two decision boundaries, using captures shaped the way
 * flow-runner.ts's own body-parsing actually populates `operationName`/
 * `query` (see flow-runner.ts: both fields are read verbatim off any
 * top-level `operationName`/`query` JSON key, GraphQL or not) rather than
 * the null-hardcoded restCapture() helper every other regression test in
 * this file family uses:
 *
 * 1. A REST capture whose body genuinely contains a top-level
 *    `operationName` string that names an ordinary REST action (not a
 *    GraphQL operation) must not, on its own, flip the whole host-scoped
 *    flow to GraphQL when no capture anywhere carries a real
 *    query/mutation-shaped document.
 * 2. A genuine named GraphQL query capture, corroborated by a same-identity
 *    Automatic-Persisted-Query re-issue (operationName present, query
 *    null), must still classify as GraphQL — proving the fix that gates
 *    classification on real document evidence doesn't regress legitimate
 *    APQ flows.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-coincidence-fixture.example.com";

function runGenerate(
  runRoot: string,
  siteId: string,
  siteOutDir: string
): { stdout: string; status: number | null } {
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [{ step: "search listings" }],
      ownBackendHostnames: [OWN_BACKEND_HOST],
    })
  );
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  return { stdout: result.stdout, status: result.status };
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("isGraphQL() — coincidental operationName/query field vs. genuine GraphQL document evidence", () => {
  it("classifies as REST when a REST capture's body genuinely carries a top-level operationName field but no capture carries a real query/mutation document", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-coincidental-operation-field-rest-e2e-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // Mirrors flow-runner.ts: a REST body containing top-level
    // `operationName`/`query` keys populates the Capture's `operationName`/
    // `query` fields verbatim, even though neither is GraphQL-shaped.
    const requestPostData = JSON.stringify({
      operationName: "searchListings",
      query: "units",
    });
    const searchCapture = {
      timestamp: "2026-08-18T10:23:02.000Z",
      phase: "search-listings",
      method: "POST",
      url: `https://${OWN_BACKEND_HOST}/api/listings/search`,
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData,
      responseHeaders: {},
      responseBody: { listings: [{ listingId: "L1", name: "Unit A" }] },
      operationName: "searchListings",
      query: "units",
      variables: null,
      decodedParams: null,
    };
    for (let i = 0; i < 3; i++) {
      writeFileSync(
        join(runRoot, "graphql", `000-search-listings-${String(i).padStart(2, "0")}.json`),
        JSON.stringify(searchCapture)
      );
    }

    const siteId = `coincidental-operation-field-rest-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    const { stdout, status } = runGenerate(runRoot, siteId, siteOutDir);

    expect(status, stdout).toBe(0);
    expect(stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);
  });

  it("still classifies as GraphQL when a genuine named query document is corroborated by a same-identity Automatic-Persisted-Query re-issue", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-coincidental-operation-field-apq-e2e-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    const operationName = "searchListings";
    const query =
      "query searchListings($filter: String) { searchListings(filter: $filter) { id name } }";

    const namedCapture = {
      timestamp: "2026-08-18T10:23:02.000Z",
      phase: "search-listings",
      method: "POST",
      url: `https://${OWN_BACKEND_HOST}/graphql`,
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({ operationName, query, variables: { filter: "all" } }),
      responseHeaders: {},
      responseBody: { searchListings: [{ id: "L1", name: "Unit A" }] },
      operationName,
      query,
      variables: { filter: "all" },
      decodedParams: null,
    };
    writeFileSync(
      join(runRoot, "graphql", "000-search-listings-named.json"),
      JSON.stringify(namedCapture)
    );

    // Automatic-Persisted-Query re-issue of the SAME operation identity: the
    // client sends only the operationName and a persisted-query hash, no
    // query text.
    const apqReissueCapture = {
      ...namedCapture,
      requestPostData: JSON.stringify({ operationName, query: null, variables: { filter: "all" } }),
      query: null,
    };
    for (let i = 0; i < 2; i++) {
      writeFileSync(
        join(runRoot, "graphql", `100-search-listings-apq-${String(i).padStart(2, "0")}.json`),
        JSON.stringify(apqReissueCapture)
      );
    }

    const siteId = `coincidental-operation-field-apq-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    const { stdout, status } = runGenerate(runRoot, siteId, siteOutDir);

    expect(status, stdout).toBe(0);
    expect(stdout).toContain(`generating plugin for ${siteId} (GraphQL,`);
  });
});
