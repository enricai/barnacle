import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * `isGraphQL()`'s vote denominator must weigh genuinely-parsed GraphQL
 * documents against the site's FULL own-backend traffic, not just the
 * subset of captures that happen to carry a truthy `.query` field. Before
 * the fix, a REST site with a small, recurring BFF-style detail endpoint
 * proxying an internal GraphQL call could have that endpoint's handful of
 * captures become a trivial 100% majority of the (tiny) query-bearing pool
 * — the old denominator — even though it's a small minority of the site's
 * real own-backend traffic: dozens of plain GET, URL-keyed REST captures
 * that never had a `.query` field to be counted in the first place.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.majority-nonquery-fixture.example.com";
const REST_ENDPOINT_COUNT = 24;
const GENUINE_GRAPHQL_CAPTURE_COUNT = 3;

/** Plain REST reads keyed by URL, not a body — one distinct endpoint each,
 * mirroring a real catalog/widgets browsing flow (list, category, item
 * detail pages). None of these carry a `query` or `operationName` field. */
function restEndpointCapture(index: number, timestamp: string): unknown {
  return {
    timestamp,
    phase: "browse",
    method: "GET",
    url: `https://${OWN_BACKEND_HOST}/api/widgets/${index}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { widgetId: `widget-${index}`, name: `Widget ${index}` },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

/** A recurring BFF-style detail endpoint proxying an internal GraphQL call:
 * genuinely-parseable query documents, but a small minority of the site's
 * overall own-backend traffic. */
function genuineGraphQLCapture(index: number, timestamp: string): unknown {
  const operationName = "widgetDetail";
  const query = `query ${operationName}($id: String) { widgetDetail(id: $id) { id spec } }`;
  return {
    timestamp,
    phase: "browse",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/bff/widget-detail`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ operationName, query, variables: { id: String(index) } }),
    responseHeaders: {},
    responseBody: { widgetDetail: { id: String(index), spec: "spec-sheet" } },
    operationName,
    query,
    variables: { id: String(index) },
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
      steps: [{ step: "browse widgets" }],
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

describe("isGraphQL() — majority non-.query own-backend traffic vs. a minority recurring genuine-GraphQL endpoint", () => {
  it("classifies as REST when a majority of own-backend captures carry no .query field, despite a recurring endpoint's genuine documents being a local majority of the old .query-only pool", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-majority-nonquery-rest-e2e-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    let secondsCursor = 0;
    const nextTimestamp = (): string =>
      `2026-08-18T10:23:${String(secondsCursor++).padStart(2, "0")}.000Z`;

    for (let i = 0; i < REST_ENDPOINT_COUNT; i++) {
      writeFileSync(
        join(runRoot, "graphql", `000-widget-${String(i).padStart(3, "0")}.json`),
        JSON.stringify(restEndpointCapture(i, nextTimestamp()))
      );
    }
    // The old `.query`-only pool would have consisted ENTIRELY of these
    // captures — a trivial 100% "majority" — despite being a small minority
    // of the ${REST_ENDPOINT_COUNT} plain REST captures above.
    for (let i = 0; i < GENUINE_GRAPHQL_CAPTURE_COUNT; i++) {
      writeFileSync(
        join(runRoot, "graphql", `999-widget-detail-${String(i).padStart(2, "0")}.json`),
        JSON.stringify(genuineGraphQLCapture(i, nextTimestamp()))
      );
    }

    const siteId = `majority-nonquery-rest-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    const { stdout, status } = runGenerate(runRoot, siteId, siteOutDir);

    expect(status, stdout).toBe(0);
    expect(stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);
  });
});
