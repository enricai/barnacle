import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * `isGraphQL()`'s vote denominator forcing the wrong `gql` boolean was the
 * producer defect (fixed separately). This test proves the two downstream
 * consumers that read that boolean recover correctly once it's corrected,
 * rather than assuming they do:
 *
 * - `extractGraphQLActionSequence`/`isSubmissionFlow` (recon-generate.ts):
 *   when `gql` was wrongly `true`, the flow was extracted down the GraphQL
 *   path, which can't see REST captures with no `.query` field — so a
 *   declared `submitEndpointPattern`/`submitBodyPattern` matching real
 *   recurring REST captures read as "0 capture(s)" even though the archive
 *   contains plenty.
 * - `resolveApplicableFoldPlans` (recon-generate.ts): resolving fold plans
 *   against that same wrong `actionSteps` set meant a declared
 *   `foldReturn.joinFields` key was rejected in favor of a guessed
 *   structural join field.
 *
 * The fixture combines bugfix-001's majority-non-`.query` REST shape (a
 * REST site with hundreds of plain-GET own-backend captures and a minority
 * BFF-style endpoint whose captures happen to carry genuinely-parseable
 * `query`-shaped bodies) with a declared `submitEndpointPattern`/
 * `submitBodyPattern` matching real recurring submission captures and a
 * declared `foldReturn.joinFields` matching real drill-down captures.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.submit-fold-cascade-fixture.example.com";
const REST_ENDPOINT_COUNT = 40;
const GENUINE_GRAPHQL_CAPTURE_COUNT = 3;
const ORDER_IDS = ["ord-0", "ord-1", "ord-2"];

/** Plain REST reads keyed by URL, not a body — the bulk of the site's own-
 * backend traffic. None of these carry a `query`/`operationName` field. */
function restReadCapture(index: number, timestamp: string): Capture {
  return {
    timestamp,
    phase: "browse",
    method: "GET",
    url: `https://${OWN_BACKEND_HOST}/api/catalog/${index}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { itemId: `item-${index}`, name: `Item ${index}` },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

/** A recurring BFF-style detail endpoint proxying an internal GraphQL call:
 * genuinely-parseable query documents, but a small minority of the site's
 * overall own-backend traffic. Mirrors bugfix-001's fixture shape — this is
 * the capture set that used to win the old `.query`-only vote pool. */
function genuineGraphQLCapture(index: number, timestamp: string): Capture {
  const operationName = "itemDetail";
  const query = `query ${operationName}($id: String) { itemDetail(id: $id) { id spec } }`;
  return {
    timestamp,
    phase: "browse",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/bff/item-detail`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ operationName, query, variables: { id: String(index) } }),
    responseHeaders: {},
    responseBody: { itemDetail: { id: String(index), spec: "spec-sheet" } },
    operationName,
    query,
    variables: { id: String(index) },
    decodedParams: null,
  };
}

/** The declared foldReturn's primary listing capture — its `results` array
 * seeds the order ids the genuine confirmations below act on. */
function listOrdersCapture(timestamp: string): Capture {
  return {
    timestamp,
    phase: "browse",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/api/orders/list`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ filter: "upcoming" }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { results: ORDER_IDS.map((orderId) => ({ orderId })) },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: { filter: "upcoming" },
  };
}

/** A genuine confirmation submission — matches the declared
 * submitEndpointPattern/submitBodyPattern. Every one must be captured. */
function confirmOrderCapture(orderId: string, timestamp: string): Capture {
  const requestPostData = JSON.stringify({ orderId });
  return {
    timestamp,
    phase: "action",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/api/orders/confirm`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { status: "confirmed", orderId },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: { orderId },
  };
}

/** Declared foldReturn drill target: its URL threads a value unrelated to
 * the declared join field, and `joinFields: ["orderId"]` only ever appears
 * in the response body here — a structural guess would pick the URL-
 * threaded field instead. */
function orderDetailCapture(timestamp: string): Capture {
  return {
    timestamp,
    phase: "action",
    method: "GET",
    url: `https://${OWN_BACKEND_HOST}/api/orders/detail/bin-7`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { details: { items: [{ orderId: "ord-2", binCode: "bin-7", qty: 4 }] } },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  let index = 0;
  const write = (capture: Capture, label: string): void => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(4, "0")}-${label}.json`),
      JSON.stringify(capture)
    );
    index++;
  };

  let secondsCursor = 0;
  const nextTimestamp = (): string =>
    `2026-08-18T10:23:${String(secondsCursor++).padStart(2, "0")}.000Z`;

  // Bulk plain-REST own-backend reads — the majority of own-backend traffic.
  for (let i = 0; i < REST_ENDPOINT_COUNT; i++) {
    write(restReadCapture(i, nextTimestamp()), `catalog-${String(i).padStart(3, "0")}`);
  }
  // The old `.query`-only pool would have consisted ENTIRELY of these — a
  // trivial 100% "majority" — despite being a small minority of the
  // REST_ENDPOINT_COUNT plain reads above.
  for (let i = 0; i < GENUINE_GRAPHQL_CAPTURE_COUNT; i++) {
    write(genuineGraphQLCapture(i, nextTimestamp()), `item-detail-${String(i).padStart(2, "0")}`);
  }
  write(listOrdersCapture(nextTimestamp()), "list-orders");
  ORDER_IDS.forEach((orderId) => {
    write(confirmOrderCapture(orderId, nextTimestamp()), `confirm-${orderId}`);
  });
  write(orderDetailCapture(nextTimestamp()), "order-detail");
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

describe("recon-generate CLI — declared submitEndpointPattern/submitBodyPattern and foldReturn.joinFields resolve once REST classification is corrected", () => {
  it("finds every declared submission capture and keys the fold on the declared joinFields, not a guessed structural field", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-submit-fold-cascade-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `submit-fold-cascade-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "browse catalog" }, { step: "confirm order", submitStep: true }],
        submitEndpointPattern: "orders/confirm",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
        foldReturn: {
          endpointPattern: "orders/detail",
          resultsPath: "results",
          drillResultsPath: "details.items",
          joinFields: ["orderId"],
        },
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combinedOutput).toBe(0);

    // Classification must have resolved REST — the genuinely-parseable
    // minority BFF endpoint must not flip the flow to GraphQL, and it never
    // logs the "0 capture(s)" submission-selection disagreement for the
    // declared pattern.
    expect(result.stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);
    expect(combinedOutput).not.toContain(
      "submission selection: declared submitEndpointPattern/submitBodyPattern (0 capture(s))"
    );
    expect(combinedOutput).not.toContain("ignoring submitEndpointPattern/submitBodyPattern");

    // Fold join field: the declared spec resolves, not a guessed fallback.
    expect(combinedOutput).not.toContain("no fold plan resolved");
    expect(combinedOutput).not.toContain("only structurally-detected fold plans");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).toContain("orders/confirm");
    expect(contract).toContain("orderId");
    expect(contract).toContain("orders/detail");
    // The fold keys on the declared joinFields field, not the URL-threaded
    // `binCode` a structural guess would have picked instead.
    expect(contract).toMatch(/String\(m\["orderId"\]\) === String\(item\.orderId\)/);
    expect(contract).not.toMatch(/String\(m\["binCode"\]\)/);

    tsconfigPath = join(REPO_ROOT, `tsconfig.recon-submit-fold-cascade.${process.pid}.json`);
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
    const referencesEmittedFiles =
      diagnostics.includes("contract.ts") || diagnostics.includes("browser-flow.ts");
    expect(referencesEmittedFiles, diagnostics).toBe(false);
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
