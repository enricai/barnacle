import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * `isGraphQL()`'s dominance requirement, isolated from host-provenance and
 * APQ-corroboration concerns already covered elsewhere: a single genuinely-
 * parsed GraphQL document capture is real evidence, but on an own-backend
 * host dominated by REST traffic it must remain a minority vote and must not
 * flip the flow's classification. The inverse -- the same shape of evidence
 * in the majority -- must still classify as GraphQL, so the dominance count
 * doesn't regress real GraphQL sites.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-dominance-fixture.example.com";

function restCapture(index: number) {
  return {
    timestamp: "2026-08-18T10:23:02.000Z",
    phase: "search-listings",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/api/listings/search`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ page: index }),
    responseHeaders: {},
    responseBody: { listings: [{ listingId: `L${index}`, name: "Unit A" }] },
    operationName: null,
    query: `page:${index}`,
    variables: null,
    decodedParams: null,
  };
}

function genuineGraphQLCapture() {
  const operationName = "searchListings";
  const query =
    "query searchListings($filter: String) { searchListings(filter: $filter) { id name } }";
  return {
    timestamp: "2026-08-18T10:23:03.000Z",
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
}

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

describe("isGraphQL() — minority vs. majority genuine GraphQL document on an own-backend host", () => {
  it("classifies as REST when exactly one genuine GraphQL document capture is outnumbered by REST captures on the same own-backend host", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-minority-genuine-graphql-rest-e2e-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    for (let i = 0; i < 20; i++) {
      writeFileSync(
        join(runRoot, "graphql", `000-search-listings-${String(i).padStart(2, "0")}.json`),
        JSON.stringify(restCapture(i))
      );
    }
    writeFileSync(
      join(runRoot, "graphql", "999-search-listings-genuine.json"),
      JSON.stringify(genuineGraphQLCapture())
    );

    const siteId = `minority-genuine-graphql-rest-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    const { stdout, status } = runGenerate(runRoot, siteId, siteOutDir);

    expect(status, stdout).toBe(0);
    expect(stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);
  });

  it("classifies as GraphQL when genuine GraphQL document captures dominate the same own-backend host's traffic", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-majority-genuine-graphql-e2e-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    for (let i = 0; i < 20; i++) {
      writeFileSync(
        join(runRoot, "graphql", `000-search-listings-${String(i).padStart(2, "0")}.json`),
        JSON.stringify(genuineGraphQLCapture())
      );
    }
    writeFileSync(
      join(runRoot, "graphql", "999-search-listings-rest.json"),
      JSON.stringify(restCapture(0))
    );

    const siteId = `majority-genuine-graphql-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    const { stdout, status } = runGenerate(runRoot, siteId, siteOutDir);

    expect(status, stdout).toBe(0);
    expect(stdout).toContain(`generating plugin for ${siteId} (GraphQL,`);
  });
});
