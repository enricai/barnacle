import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addSeconds } from "date-fns";
import { afterEach, describe, expect, it } from "vitest";

import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Combines the full reported cascade in one archive, each condition drawn
 * from the real shapes the live pipeline produces rather than a
 * hand-forced-truthy field: a large REST-majority of own-backend traffic
 * with `query: null` on every capture (the real shape `buildCapture` and
 * live traffic both produce), a small minority endpoint whose captures are
 * genuinely-parsed GraphQL documents (real `operationName`/`query`
 * populated from an actual request body, not a coincidental text match),
 * a declared submitEndpointPattern with several real dominant matches, and
 * a declared foldReturn.joinFields spec that resolves against a real
 * matching join key on a genuine drill-down capture. Each condition mirrors
 * one narrower regression test's fix; this is the single checkable proof
 * all four close together on one archive, not a duplicate of any one of
 * them.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.noquery-majority-cascade-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;
const GRAPHQL_URL = `https://${OWN_BACKEND_HOST}/graphql`;

const BASE_TIMESTAMP = new Date("2026-08-18T10:23:00.000Z");
const JOIN_VALUE = "ITEM-JOIN-KEY-01";
const SUBMIT_FIELD_VALUE = "ORDER-CONFIRMATION-TOKEN-01";
const REST_NOISE_COUNT = 900;
const SUBMIT_COUNT = 3;
const GENUINE_GRAPHQL_COUNT = 3;

// Bulk own-backend REST reads: `buildCapture` always sets `query: null`, the
// real shape live traffic produces, so this pool is invisible to a
// query-only voting pool and must anchor the REST classification.
function restNoiseCaptures(): Capture[] {
  return Array.from({ length: REST_NOISE_COUNT }, (_unused, index) =>
    buildCapture({
      method: "GET",
      url: `${LIST_URL}?page=${index}`,
      requestPostData: null,
      responseBody: { results: [{ itemId: `noise-${index}` }] },
      timestamp: addSeconds(BASE_TIMESTAMP, index).toISOString(),
    })
  );
}

// The declared foldReturn's seed listing: threads the real join value so the
// drill capture below has a real key to resolve against.
function listCapture(): Capture {
  return buildCapture({
    method: "GET",
    url: LIST_URL,
    requestPostData: null,
    responseBody: { results: [{ itemId: JOIN_VALUE }] },
    timestamp: addSeconds(BASE_TIMESTAMP, REST_NOISE_COUNT).toISOString(),
  });
}

// The declared foldReturn's drill target: a genuine drill-down capture whose
// response body carries the declared join field's real matching value.
function drillCapture(): Capture {
  return buildCapture({
    method: "GET",
    url: `${DRILL_URL}?itemId=${JOIN_VALUE}`,
    requestPostData: null,
    responseBody: { itemId: JOIN_VALUE, price: 42 },
    timestamp: addSeconds(BASE_TIMESTAMP, REST_NOISE_COUNT + 1).toISOString(),
  });
}

// Real dominant matches against the declared submitEndpointPattern: every
// one must be captured, not an undercounted subset.
function submitCaptures(): Capture[] {
  return Array.from({ length: SUBMIT_COUNT }, (_unused, index) =>
    buildCapture({
      url: SUBMIT_URL,
      requestPostData: JSON.stringify({
        itemId: JOIN_VALUE,
        confirmationToken: `${SUBMIT_FIELD_VALUE}-${index}`,
      }),
      responseBody: { ok: true },
      timestamp: addSeconds(BASE_TIMESTAMP, REST_NOISE_COUNT + 2 + index).toISOString(),
    })
  );
}

// The reported minority: a small recurring endpoint whose captures are
// genuinely-parsed GraphQL documents (real `operationName`/`query` off an
// actual request body), trivially dominating the tiny has-`.query` subset
// while remaining a small minority of the archive's real own-backend
// traffic overall. This must not flip the flow's classification.
function genuineGraphQLCaptures(): Capture[] {
  const operationName = "searchCatalog";
  const query =
    "query searchCatalog($filter: String) { searchCatalog(filter: $filter) { id name } }";
  return Array.from({ length: GENUINE_GRAPHQL_COUNT }, (_unused, index) => ({
    timestamp: addSeconds(BASE_TIMESTAMP, REST_NOISE_COUNT + 100 + index).toISOString(),
    phase: "search-catalog",
    method: "POST",
    url: GRAPHQL_URL,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ operationName, query, variables: { filter: "all" } }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { searchCatalog: [{ id: JOIN_VALUE, name: "Item" }] },
    operationName,
    query,
    variables: { filter: "all" },
    decodedParams: null,
  }));
}

function fixtureCaptures(): Capture[] {
  return [
    ...restNoiseCaptures(),
    listCapture(),
    drillCapture(),
    ...submitCaptures(),
    ...genuineGraphQLCaptures(),
  ];
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(4, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
}

let workDir: string | null = null;
let siteOutDir: string | null = null;
let tsconfigPath: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  if (tsconfigPath) rmSync(tsconfigPath, { force: true });
  workDir = null;
  siteOutDir = null;
  tsconfigPath = null;
});

describe("recon-generate CLI — no-query REST-majority traffic, genuine GraphQL minority, submit pattern, and fold join cascade", () => {
  it("classifies as REST, resists the genuine GraphQL minority, resolves the declared submit pattern and fold join key, and emits a compiling contract", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    const captures = fixtureCaptures();
    expect(captures.length).toBeGreaterThanOrEqual(900);

    workDir = mkdtempSync(join(tmpdir(), "barnacle-noquery-majority-cascade-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, captures);

    const siteId = `noquery-majority-cascade-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
          { step: "open item detail panel" },
          { step: "submit item selection", submitStep: true },
        ],
        submitEndpointPattern: "catalog/submit",
        requireSubmitEndpointMatch: true,
        foldReturn: {
          endpointPattern: "catalog/detail",
          resultsPath: "results",
          drillResultsPath: "itemId",
          joinFields: ["itemId"],
        },
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).not.toContain(`generating plugin for ${siteId} (GraphQL,`);
    expect(out).not.toContain("disagrees with the unfiltered heuristic");
    expect(out).not.toContain("declared spec resolved no fold plan");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");
    expect(contract).toContain("catalog/submit");
    expect(contract).toContain("confirmationToken");
    expect(contract).toContain("catalog/detail");

    tsconfigPath = join(REPO_ROOT, `tsconfig.noquery-majority-cascade.${process.pid}.json`);
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: {
          noEmit: true,
          incremental: false,
          tsBuildInfoFile: null,
          paths: {
            "@/*": ["./src/*"],
            "@test/*": ["./test/*"],
            "@enricai/barnacle/*": ["./src/*"],
          },
        },
        include: [`src/sites/${siteId}/**/*.ts`],
      })
    );

    const check = spawnSync(TSC_BIN, ["-p", tsconfigPath, "--noEmit"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const diagnostics = `${check.stdout}\n${check.stderr}`;
    expect(check.status, diagnostics).toBe(0);
  }, 120_000);
});
