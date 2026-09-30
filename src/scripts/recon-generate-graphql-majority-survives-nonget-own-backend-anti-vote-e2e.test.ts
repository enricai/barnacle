import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Pins the opposite-direction regression `isGraphQL`'s non-GET anti-vote
 * widening (recon-generate.ts's `restAntiVoteCandidates` now admits any
 * method, not just GET) must not introduce: a flow whose own-backend
 * evidence is genuinely-parsed GraphQL documents, with only a handful of
 * incidental non-query POST captures (e.g. an auth/token-mint call with a
 * plain JSON body, no `.query`/`operationName`) newly joining the anti-vote
 * pool under the widened filter, must still classify as GraphQL.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.graphql-majority-nonget-anti-vote-fixture.example.com";
const GRAPHQL_URL = `https://${OWN_BACKEND_HOST}/graphql`;
const AUTH_TOKEN_URL = `https://${OWN_BACKEND_HOST}/auth/token`;

function genuineGraphQLCapture(index: number) {
  const operationName = "searchListings";
  const query =
    "query searchListings($filter: String) { searchListings(filter: $filter) { id name } }";
  return {
    timestamp: "2026-08-19T11:05:00.000Z",
    phase: "search-listings",
    method: "POST",
    url: GRAPHQL_URL,
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

// An incidental non-GET POST to a different own-backend endpoint: a plain
// JSON body with no `.query`/`operationName`, so under the widened filter it
// newly joins the REST anti-vote pool it was previously excluded from
// (pre-fix admitted GET only). Each occurrence carries a distinct response
// token so it doesn't collapse under isZeroVarianceRepeatCapture into the
// same single representative.
function authTokenMintCapture(index: number) {
  return {
    timestamp: "2026-08-19T11:05:01.000Z",
    phase: "search-listings",
    method: "POST",
    url: AUTH_TOKEN_URL,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ grantType: "refresh_token" }),
    responseHeaders: {},
    responseBody: { accessToken: `token-${index}`, expiresIn: 3600 },
    operationName: null,
    query: null,
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

const GENUINE_GRAPHQL_CAPTURE_COUNT = 10;
const AUTH_TOKEN_MINT_CAPTURE_COUNT = 2;

describe("isGraphQL() — genuine GraphQL majority survives incidental non-GET own-backend anti-votes", () => {
  it("classifies as GraphQL when a handful of incidental non-query POST captures join the widened anti-vote pool", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-graphql-majority-nonget-anti-vote-e2e-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    for (let i = 0; i < GENUINE_GRAPHQL_CAPTURE_COUNT; i++) {
      writeFileSync(
        join(runRoot, "graphql", `000-search-listings-${String(i).padStart(2, "0")}.json`),
        JSON.stringify(genuineGraphQLCapture(i))
      );
    }
    for (let i = 0; i < AUTH_TOKEN_MINT_CAPTURE_COUNT; i++) {
      writeFileSync(
        join(runRoot, "graphql", `999-auth-token-mint-${i}.json`),
        JSON.stringify(authTokenMintCapture(i))
      );
    }

    const siteId = `graphql-majority-nonget-anti-vote-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    const { stdout, status } = runGenerate(runRoot, siteId, siteOutDir);

    expect(status, stdout).toBe(0);
    expect(stdout).toContain(`generating plugin for ${siteId} (GraphQL,`);
  });
});
