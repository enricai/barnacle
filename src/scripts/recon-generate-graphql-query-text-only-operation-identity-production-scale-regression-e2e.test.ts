import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Item test-002 reproduces the query-text-only operation-identity fix at a
 * small, hand-built fold plan fixture. This test proves it holds at the
 * reported scale: a real archive is dominated by thousands of unrelated
 * noise captures, not a couple dozen. Here the same operationName-null,
 * query-text-named GraphQL search primary must still be resolved into the
 * fold plan when it is a 19-in-2000+ minority, crowded by a large
 * third-party noise population and a repeating same-origin noise widget
 * family — the failure mode this test targets is losing the primary among
 * noise volume, distinct from test-002's shape-of-the-primary-itself
 * failure mode.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.query-text-only-production-scale-fixture.example.com";
const SEARCH_URL = `https://${OWN_BACKEND_HOST}/graphql`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/catalog/api/v1/variant-detail`;
const SAME_ORIGIN_NOISE_URL = `https://${OWN_BACKEND_HOST}/telemetry-ping`;

const THIRD_PARTY_NOISE_URLS = [
  "https://sync.adsrvr.org/beacon?id=1",
  "https://www.googletagmanager.com/gtm.js?id=GTM-XXXX",
  "https://stats.g.doubleclick.net/pixel",
  "https://connect.facebook.net/en_US/fbevents.js",
  "https://static.hotjar.com/c/hotjar.js",
];

const SEARCH_QUERY =
  "query catalogSearch($page: Int) { catalogSearch(page: $page) { results { items { id variants { id price } } } } }";

const REPEAT_COUNT = 19;
const THIRD_PARTY_NOISE_COUNT = 1200;
const SAME_ORIGIN_NOISE_COUNT = 800;

// `buildCapture` hard-codes `query`/`operationName`/`variables` to null, which
// is right for the REST noise below but wrong for the primary: the fix under
// test is specifically that `isGraphQL()`/`parsedOperationName()` fall back to
// parsing the operation name out of `query` text when `operationName` is
// null, so these two captures are built by hand with `query` populated and
// `operationName` left null, matching test-002's exact fixture shape.
function catalogSearchCapture(page: number, timestamp: string): Capture {
  return {
    timestamp,
    phase: "browse",
    method: "POST",
    url: SEARCH_URL,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: { page } }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      data: {
        catalogSearch: {
          results: {
            items: [
              {
                id: "item-fixed",
                variants: [{ id: "variant-fixed", price: 100 + page }],
              },
            ],
          },
        },
      },
    },
    operationName: null,
    query: SEARCH_QUERY,
    variables: { page },
    decodedParams: null,
  };
}

function variantDrillCapture(variantId: string, timestamp: string): Capture {
  return {
    timestamp,
    phase: "browse",
    method: "GET",
    url: `${DRILL_URL}?variantId=${variantId}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ id: variantId, price: 999 }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function productionScaleCaptures(): Capture[] {
  let secondsCursor = 0;
  const nextTimestamp = (): string =>
    `2024-01-01T${String(Math.floor(secondsCursor / 3600)).padStart(2, "0")}:${String(
      Math.floor((secondsCursor++ % 3600) / 60)
    ).padStart(2, "0")}:${String(secondsCursor % 60).padStart(2, "0")}Z`;

  const search = Array.from({ length: REPEAT_COUNT }, (_, i) =>
    catalogSearchCapture(i, nextTimestamp())
  );
  const drill = [variantDrillCapture("variant-fixed", nextTimestamp())];

  const thirdPartyNoise = Array.from({ length: THIRD_PARTY_NOISE_COUNT }, (_, i) =>
    buildCapture({
      url: THIRD_PARTY_NOISE_URLS[i % THIRD_PARTY_NOISE_URLS.length]!,
      requestPostData: null,
      responseBody: { ok: true },
      timestamp: nextTimestamp(),
    })
  );

  const sameOriginNoise = Array.from({ length: SAME_ORIGIN_NOISE_COUNT }, (_, i) =>
    buildCapture({
      url: SAME_ORIGIN_NOISE_URL,
      requestPostData: null,
      responseBody: { impressionId: `imp-${i}-${Math.random()}` },
      timestamp: nextTimestamp(),
    })
  );

  return [...search, ...drill, ...thirdPartyNoise, ...sameOriginNoise];
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(5, "0")}-capture.json`),
      JSON.stringify(capture)
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

describe("GraphQL search primary named only in its query text — fold plan resolution at production scale", () => {
  it("resolves the declared foldReturn when the primary is a 19-in-2000+ minority against mixed noise", () => {
    const captures = productionScaleCaptures();
    expect(captures.length).toBeGreaterThanOrEqual(2000);

    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-query-text-only-production-scale-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, captures);

    const siteId = `gql-query-text-only-production-scale-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search the catalog" }],
        foldReturn: {
          endpointPattern: "/catalog/api/v1/variant-detail",
          resultsPath: "data.catalogSearch.results.items.*.variants",
          drillResultsPath: "detail",
          joinFields: ["id"],
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
    expect(out).not.toContain("no fold plan resolved");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("/catalog/api/v1/variant-detail");
    expect(contract).toContain("variants");
    expect(contract).toContain("price");
    expect(contract).not.toContain("telemetry-ping");
    expect(contract).not.toContain("adsrvr.org");
  }, 120_000);
});
