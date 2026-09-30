import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * `isGraphQL()`'s corroboration vote now weighs its dominance ratio against
 * ALL own-backend traffic, not just the has-query subset -- so a genuinely
 * GraphQL site whose own-backend host also carries a few zero-query-field
 * captures (a health check, an asset ping) must still classify as GraphQL:
 * those captures widen the denominator but must not be able to outvote real
 * parsed GraphQL documents that already dominate the host's traffic.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-majority-traffic-fixture.example.com";

function genuineGraphQLCapture(index: number) {
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
    requestPostData: JSON.stringify({
      operationName,
      query,
      variables: { filter: `page-${index}` },
    }),
    responseHeaders: {},
    responseBody: { searchListings: [{ id: `L${index}`, name: "Unit A" }] },
    operationName,
    query,
    variables: { filter: `page-${index}` },
    decodedParams: null,
  };
}

function zeroQueryFieldCapture(index: number) {
  return {
    timestamp: "2026-08-18T10:23:04.000Z",
    phase: "search-listings",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/health`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ ping: index }),
    responseHeaders: {},
    responseBody: { ok: true },
    operationName: null,
    variables: null,
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

describe("isGraphQL() — genuinely GraphQL-majority own-backend traffic with zero-query-field noise mixed in", () => {
  it("classifies as GraphQL when genuine GraphQL captures dominate own-backend traffic even with a few zero-query-field captures on the same host", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-genuine-graphql-majority-traffic-e2e-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    for (let i = 0; i < 20; i++) {
      writeFileSync(
        join(runRoot, "graphql", `000-search-listings-${String(i).padStart(2, "0")}.json`),
        JSON.stringify(genuineGraphQLCapture(i))
      );
    }
    for (let i = 0; i < 3; i++) {
      writeFileSync(
        join(runRoot, "graphql", `999-search-listings-health-${i}.json`),
        JSON.stringify(zeroQueryFieldCapture(i))
      );
    }

    const siteId = `genuine-graphql-majority-traffic-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    const { stdout, status } = runGenerate(runRoot, siteId, siteOutDir);

    expect(status, stdout).toBe(0);
    expect(stdout).toContain(`generating plugin for ${siteId} (GraphQL,`);
  });
});
