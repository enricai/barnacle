import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Combines the two shapes each covered separately by
 * recon-generate-fallback-domain-minority-graphql-subdomain-does-not-flip-rest-classification-e2e.test.ts
 * (no declared ownBackendHostnames, so primaryHost/fallbackDomain are
 * derived purely from capture majority) and
 * recon-generate-primary-host-dominant-traffic-mixed-noise-classification-fold-submit-e2e.test.ts
 * (a declared submitEndpointPattern/requireSubmitEndpointMatch and a
 * declared foldReturn.joinFields). Neither sibling test exercises the
 * combination: a flow with NO declared own-backend hosts at all, whose
 * declared submitEndpointPattern and foldReturn.joinFields must still
 * resolve against the dominant host's genuine captures, while a
 * same-registrable-domain undeclared-subdomain GraphQL-shaped noise
 * capture must never flip classification or starve either declared
 * pattern of its real matches.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PRIMARY_HOST = "www.catalog-orders-fixture.example.org";
// Same registrable domain as PRIMARY_HOST, but never declared anywhere —
// with no ownBackendHostnames declared at all, it is reachable only through
// the derived fallbackDomain registrable-domain fallback.
const UNDECLARED_SUBDOMAIN_HOST = "beacon.catalog-orders-fixture.example.org";

const ITEM_IDS = ["item-0", "item-1", "item-2"];

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

function graphqlCapture(overrides: {
  url: string;
  operationName: string;
  query: string;
  responseBody: unknown;
  timestamp: string;
}): Capture {
  return {
    timestamp: overrides.timestamp,
    phase: "home",
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      operationName: overrides.operationName,
      query: overrides.query,
    }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: overrides.operationName,
    query: overrides.query,
    variables: null,
    decodedParams: null,
  };
}

/**
 * A run dir with NO own-backend hosts declared anywhere, so primaryHost and
 * fallbackDomain are derived purely from the dominant host's captures. The
 * dominant host carries genuine matches for a declared submitEndpointPattern
 * and the declared foldReturn.joinFields, while an undeclared
 * same-registrable-domain subdomain fires GraphQL-shaped noise.
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

  // The dominant primary host's listing capture, seeding the item ids the
  // declared foldReturn.resultsPath resolves against. Written first so
  // deriveBaseUrl's "first non-noise capture wins" rule (there is no
  // capture-count majority vote when no ownBackendHostnames are declared)
  // picks the primary host, not the noise below.
  write(
    restCapture({
      method: "POST",
      url: `https://${PRIMARY_HOST}/api/orders/search`,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { results: ITEM_IDS.map((itemId) => ({ itemId })) },
      timestamp: "2026-08-18T10:22:30.000Z",
    }),
    "list-items"
  );

  // Undeclared same-registrable-domain subdomain's GraphQL-shaped noise —
  // reachable only through the derived fallbackDomain path, since no
  // ownBackendHostnames are declared at all.
  for (let i = 0; i < 2; i++) {
    write(
      graphqlCapture({
        url: `https://${UNDECLARED_SUBDOMAIN_HOST}/graphql`,
        operationName: "BeaconPing",
        query: "query BeaconPing { beaconPing { seen } }",
        responseBody: { data: { beaconPing: { seen: true } } },
        timestamp: `2026-08-18T10:20:2${i}.000Z`,
      }),
      "subdomain-noise"
    );
  }

  // Bulk own-backend read noise on the primary host, unrelated to the
  // declared submit pattern or the join field.
  for (let i = 0; i < 20; i++) {
    write(
      restCapture({
        method: "GET",
        url: `https://${PRIMARY_HOST}/api/orders/availability`,
        requestPostData: null,
        responseBody: { slots: [`slot-${i}`] },
        timestamp: `2026-08-18T10:23:${String(i).padStart(2, "0")}.000Z`,
      }),
      "availability-noise"
    );
  }

  // Genuine submissions matching the declared submitEndpointPattern — every
  // one must be captured; an undercount would silently drop one or more.
  ITEM_IDS.forEach((itemId, i) => {
    write(
      restCapture({
        method: "POST",
        url: `https://${PRIMARY_HOST}/api/orders/confirm`,
        requestPostData: JSON.stringify({ itemId }),
        responseBody: { status: "confirmed", itemId },
        timestamp: `2026-08-18T10:24:0${i}.000Z`,
      }),
      `confirm-${itemId}`
    );
  });

  // Declared foldReturn drill target: its URL threads `slotCode` — a
  // structural guess would latch onto THAT field, never the declared
  // `itemId` join field, which appears only in the primary host's own
  // results and this drill response, never in any request URL/body.
  write(
    restCapture({
      method: "GET",
      url: `https://${PRIMARY_HOST}/api/orders/detail/slot-2`,
      requestPostData: null,
      responseBody: {
        details: { items: [{ itemId: "item-2", slotCode: "slot-2", guests: 4 }] },
      },
      timestamp: "2026-08-18T10:24:10.000Z",
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

describe("recon-generate CLI — no declared own-backend hosts, declared submitEndpointPattern and foldReturn resolve under the fallback-domain path", () => {
  it("classifies REST, keeps every declared-pattern submission, resolves the declared fold join field, and emits a compiling contract", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-fallback-domain-declared-submit-and-fold-patterns-resolve-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `fallback-domain-declared-submit-and-fold-patterns-resolve-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    // Deliberately NO `ownBackendHostnames` field — readOwnBackendHostnames
    // returns [] for this shape, which activates the registrable-domain
    // fallback branch in isAllowedFixtureHost, the exact path the report's
    // flow hit.
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "check availability" }, { step: "confirm item", submitStep: true }],
        submitEndpointPattern: "orders/confirm",
        requireSubmitEndpointMatch: true,
        foldReturn: {
          endpointPattern: "orders/detail",
          resultsPath: "results",
          drillResultsPath: "details.items",
          joinFields: ["itemId"],
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

    // Symptom 1: classification. The undeclared subdomain's noise must
    // never flip the dominant primary host's REST-majority flow to GraphQL.
    expect(result.stdout).toContain(`generating plugin for ${siteId} (submission flow,`);
    expect(result.stdout).not.toContain("GraphQL");

    // Symptom 2: the declared submitEndpointPattern's real matches must not
    // be discarded as a spurious 0-capture disagreement against the
    // unfiltered heuristic action sequence starved by the subdomain noise.
    expect(combinedOutput).not.toContain("disagrees with the unfiltered heuristic action sequence");
    expect(combinedOutput).not.toContain("0 capture(s)");

    // Symptom 3: the declared fold join field resolves — not rejected in
    // favor of a structurally-detected guess keyed on the drill URL's own
    // slotCode.
    expect(combinedOutput).not.toContain("only structurally-detected fold plans");
    expect(combinedOutput).not.toContain("declared joinFields were not applied");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).not.toContain("BeaconPing");
    expect(contract).toContain("orders/confirm");
    expect(contract).toContain("itemId");
    expect(contract).toContain("orders/detail");

    // Symptom 4: the emitted contract compiles cleanly.
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.recon-fallback-domain-declared-submit-and-fold.${process.pid}.json`
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
