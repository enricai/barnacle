import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addSeconds } from "date-fns";
import { afterEach, describe, expect, it } from "vitest";

import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * {@link isGraphQL}'s voting pool must include real own-backend REST/GET
 * traffic as anti-votes, not just the query-bearing subset: hundreds of REST
 * captures produced with `query: null` (the real shape `buildCapture` and
 * live traffic both produce, unlike a hand-forced-truthy `query` field) are
 * invisible to a query-only voting pool, so a small recurring endpoint whose
 * captures happen to be genuinely-parsed GraphQL documents can become a
 * trivial majority of the tiny has-`.query` subset while remaining a small
 * minority of the site's real own-backend traffic overall. That must not
 * flip the flow's classification to GraphQL.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.query-subset-dominance-fixture.example.com";
const BASE_TIMESTAMP = new Date("2026-08-18T10:23:00.000Z");

function restListingCapture(index: number) {
  return buildCapture({
    method: "GET",
    url: `https://${OWN_BACKEND_HOST}/api/listings/${index}`,
    requestPostData: null,
    responseBody: { listingId: `L${index}`, name: "Unit A" },
    timestamp: addSeconds(BASE_TIMESTAMP, index).toISOString(),
  });
}

function genuineGraphQLCapture(index: number) {
  const operationName = "searchListings";
  const query =
    "query searchListings($filter: String) { searchListings(filter: $filter) { id name } }";
  return {
    timestamp: addSeconds(BASE_TIMESTAMP, 1000 + index).toISOString(),
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

describe("isGraphQL() — a genuine-document majority of the has-query subset must not outvote real REST volume", () => {
  it("classifies as REST when genuinely-parsed GraphQL documents dominate the tiny query-bearing subset but stay a small minority of real own-backend traffic", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-query-subset-dominance-rest-e2e-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    const REST_CAPTURE_COUNT = 200;
    for (let i = 0; i < REST_CAPTURE_COUNT; i++) {
      writeFileSync(
        join(runRoot, "graphql", `000-search-listings-${String(i).padStart(3, "0")}.json`),
        JSON.stringify(restListingCapture(i))
      );
    }
    const GENUINE_GRAPHQL_CAPTURE_COUNT = 3;
    for (let i = 0; i < GENUINE_GRAPHQL_CAPTURE_COUNT; i++) {
      writeFileSync(
        join(runRoot, "graphql", `999-search-listings-genuine-${i}.json`),
        JSON.stringify(genuineGraphQLCapture(i))
      );
    }

    const siteId = `query-subset-dominance-rest-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    const { stdout, status } = runGenerate(runRoot, siteId, siteOutDir);

    expect(status, stdout).toBe(0);
    expect(stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);
  });
});
