import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Directly reproduces the report's symptom #3 against a correctly-scoped,
 * correctly-classified archive: a declared foldReturn.joinFields (e.g.
 * `orderId`) gets rejected in favor of a structurally-guessed join key (the
 * URL-threaded `itemId`) even though the declared field genuinely appears on
 * both the primary item and the drill-down response.
 *
 * This extends test-003's fixture shape (same dominant/redirect hosts, same
 * classification-noise ingredients) rather than building an independent
 * archive — resolveFoldPlan/resolveApplicableFoldPlans consume the SAME
 * action sequence extractActionSequence produces, so proving the declared
 * spec wins requires the same correctly-classified upstream sequence
 * test-003 exercises for the submit-pattern consumer site. This test is NOT
 * a retest of host-scoping or classification; it targets the fold-resolution
 * consumer site specifically (recon-generate.ts's resolveFoldPlan /
 * resolveApplicableFoldPlans, and mergeSpecPlanOntoSamePrimary's declared-
 * override of a structural target's joinFields).
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const DOMINANT_HOST = "api.inventory-fixture.example.org";
// A genuinely different registrable domain from DOMINANT_HOST, standing in
// for the report's unplanned mid-session redirect host -- noise that must
// never anchor baseUrl or dilute the submission-selection vote.
const REDIRECT_HOST = "accounts.inventory-fixture-auth.example.net";

const ITEMS = Array.from({ length: 18 }, (_, i) => ({
  itemId: `sku-${i}`,
  orderId: `ord-${i}`,
}));

function restCapture(overrides: {
  method: string;
  url: string;
  requestPostData: string | null;
  responseBody: unknown;
  timestamp: string;
}): Capture {
  return {
    timestamp: overrides.timestamp,
    phase: "action",
    method: overrides.method,
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData,
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams:
      overrides.requestPostData !== null ? JSON.parse(overrides.requestPostData) : null,
  };
}

function graphqlLookingCapture(overrides: {
  url: string;
  query: string;
  responseBody: unknown;
  timestamp: string;
}): Capture {
  return {
    timestamp: overrides.timestamp,
    phase: "action",
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: overrides.query }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: null,
    query: overrides.query,
    variables: null,
    decodedParams: { query: overrides.query },
  };
}

/**
 * Reproduces the report archive's shape at small scale, as test-003 does for
 * the submitEndpointPattern consumer site, with one deliberate addition: the
 * primary listing item and the foldReturn drill target both carry an
 * `orderId` field that never threads through any request URL or body — only
 * `itemId` does, via the drill endpoint's own path segment
 * (`/inventory/detail/sku-4`). A structural join-field guess, which only
 * ever infers fields that demonstrably thread from request to response, can
 * therefore only ever guess `itemId`. The declared `foldReturn.joinFields:
 * ["orderId"]` names the field that must win instead.
 */
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

  // Redirect/noise host, arriving first purely due to async completion
  // timing, standing in for the report's mid-session login-domain detour.
  for (let i = 0; i < 6; i++) {
    write(
      restCapture({
        method: "GET",
        url: `https://${REDIRECT_HOST}/sso/session`,
        requestPostData: null,
        responseBody: { authenticated: true },
        timestamp: `2026-09-01T09:00:0${i}.000Z`,
      }),
      "redirect-host-noise"
    );
  }

  // The dominant host's listing capture, seeding both the URL-threaded
  // itemId a structural guess would latch onto AND the never-threaded
  // orderId the declared spec names instead.
  write(
    restCapture({
      method: "POST",
      url: `https://${DOMINANT_HOST}/api/inventory/search`,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { results: ITEMS },
      timestamp: "2026-09-01T09:01:00.000Z",
    }),
    "list-items"
  );

  // Bulk own-backend zero-variance repeat noise on the dominant host -- the
  // same response every call, the shape the rescued REST anti-vote keeps as
  // genuine own-backend evidence instead of erasing to zero.
  for (let i = 0; i < 25; i++) {
    write(
      restCapture({
        method: "GET",
        url: `https://${DOMINANT_HOST}/api/inventory/categories`,
        requestPostData: null,
        responseBody: { categories: ["tools", "parts", "kits"] },
        timestamp: `2026-09-01T09:02:${String(i).padStart(2, "0")}.000Z`,
      }),
      "categories-zero-variance"
    );
  }

  // A single genuinely-parsed GraphQL-shaped document on the dominant host's
  // own registrable domain -- real signal, but too small a share of the
  // host-scoped voting pool to flip classification away from REST.
  write(
    graphqlLookingCapture({
      url: `https://${DOMINANT_HOST}/graphql`,
      query: `query RelatedItems { relatedItems(id: "sku-0") { id } }`,
      responseBody: { data: { relatedItems: [{ id: "sku-0" }] } },
      timestamp: "2026-09-01T09:03:00.000Z",
    }),
    "graphql-minority"
  );

  // Genuine submissions matching the declared submitEndpointPattern -- 18 of
  // them, mirroring the report's real, greppable match counts.
  ITEMS.forEach(({ itemId }, i) => {
    write(
      restCapture({
        method: "POST",
        url: `https://${DOMINANT_HOST}/api/inventory/reserve`,
        requestPostData: JSON.stringify({ itemId }),
        responseBody: { itemId },
        timestamp: `2026-09-01T09:04:${String(i).padStart(2, "0")}.000Z`,
      }),
      `reserve-${itemId}`
    );
  });

  // Declared foldReturn drill target. The drill URL itself only ever
  // threads `itemId` (the path segment); `orderId` appears solely inside
  // both the primary listing item and this drill response, so it can only
  // be trusted via the declared spec, never inferred structurally.
  write(
    restCapture({
      method: "GET",
      url: `https://${DOMINANT_HOST}/api/inventory/detail/sku-4`,
      requestPostData: null,
      responseBody: {
        details: {
          items: [{ itemId: "sku-4", orderId: "ord-4", warehouseCode: "wh-4", quantity: 7 }],
        },
      },
      timestamp: "2026-09-01T09:05:00.000Z",
    }),
    "listing-detail"
  );
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

describe("recon-generate CLI — declared foldReturn.joinFields resolves over a structural guess once the action sequence genuinely contains the join-bearing captures", () => {
  it("keys the emitted fold logic on the declared orderId field, not the URL-threaded itemId structural guess", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-declared-fold-joinfields-resolves-after-correct-action-sequence-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `declared-fold-joinfields-resolves-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    // Deliberately NO `ownBackendHostnames` field, exercising the same
    // undeclared-hosts scope resolution the report's real flow used.
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "check inventory" }, { step: "reserve item", submitStep: true }],
        submitEndpointPattern: "inventory/reserve",
        requireSubmitEndpointMatch: true,
        foldReturn: {
          endpointPattern: "inventory/detail",
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

    // Classification: the dominant host's minority GraphQL-shaped traffic
    // and zero-variance repeat REST traffic must never flip this to GraphQL.
    expect(result.stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);
    expect(result.stdout).toContain(`generating plugin for ${siteId} (submission flow,`);

    // The regression proper: the declared spec must resolve a fold plan at
    // all, never falling back to "only structurally-detected fold plans".
    expect(combinedOutput).not.toContain("declared spec resolved no fold plan");
    expect(combinedOutput).not.toContain("only structurally-detected fold plans");
    expect(combinedOutput).not.toContain("declared joinFields were not applied");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    // The fold-resolution consumer site: the declared join field must reach
    // the emitted contract, proving mergeSpecPlanOntoSamePrimary's declared
    // override won over the structural guess.
    expect(contract).toContain(DOMINANT_HOST);
    expect(contract).not.toContain(REDIRECT_HOST);
    expect(contract).toContain("inventory/detail");
    expect(contract).toContain("orderId");

    // The URL-threaded field a structural guess would latch onto must NOT
    // have been emitted as the fold's join key.
    const foldMatchSection = contract.slice(contract.indexOf("orderId") - 400);
    expect(foldMatchSection).not.toMatch(/\bproductId\b/);

    // The emitted contract must compile cleanly.
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.recon-declared-fold-joinfields-resolves.${process.pid}.json`
    );
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
