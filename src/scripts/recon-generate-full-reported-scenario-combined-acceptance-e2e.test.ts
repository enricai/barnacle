import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Reproduces the full reported defect_shape as a single campaign-level
 * acceptance contract, combining every condition the narrower per-fix
 * regression tests only exercise in isolation: a declared secondary
 * own-backend auth-redirect host whose real GraphQL-shaped captures are
 * ordered BEFORE the dominant own-backend host's captures (bugfix-005's
 * order-independent primary-host resolution), a declared
 * submitEndpointPattern with genuine matching captures on the dominant host
 * amid own-backend read noise (bugfix-002/004), and a declared foldReturn
 * with joinFields that only resolves via a drill response, never a
 * structural guess (bugfix-004). None of bugfix-002 through bugfix-005
 * alone can satisfy this file: each fixes one narrowing site, and a
 * regression in any single one reproduces the reported "misclassified as
 * GraphQL, declared join field rejected, output does not compile" failure
 * shape here even though its own narrower test still passes.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PRIMARY_HOST = "www.listing-desk-fixture.example.com";
const SECONDARY_OWN_BACKEND_HOST = "auth.listing-desk-fixture.example.com";

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
 * A run dir where the declared secondary own-backend host (a legitimate
 * mid-session auth redirect target) fires real GraphQL-shaped captures
 * ordered BEFORE any of the dominant primary host's overwhelming REST
 * traffic — the exact "captures happen to arrive first" ordering the
 * report describes — while the dominant host carries genuine submission
 * captures matching the declared submitEndpointPattern and a drill target
 * whose response (not its URL) carries the declared foldReturn.joinFields
 * value.
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

  // The declared secondary own-backend host's real GraphQL traffic — fired
  // FIRST, before any dominant-host capture is written.
  for (let i = 0; i < 3; i++) {
    write(
      graphqlCapture({
        url: `https://${SECONDARY_OWN_BACKEND_HOST}/graphql`,
        operationName: "SessionRefresh",
        query: "mutation SessionRefresh($token: String!) { sessionRefresh(token: $token) { ok } }",
        responseBody: { data: { sessionRefresh: { ok: true } } },
        timestamp: `2026-08-18T10:20:0${i}.000Z`,
      }),
      "auth-redirect-noise"
    );
  }

  // The dominant primary host's listing capture, seeding the item ids the
  // declared foldReturn.resultsPath resolves against.
  write(
    restCapture({
      method: "POST",
      url: `https://${PRIMARY_HOST}/api/listings/search`,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { results: ITEM_IDS.map((itemId) => ({ itemId })) },
      timestamp: "2026-08-18T10:22:30.000Z",
    }),
    "list-items"
  );

  // Bulk own-backend read noise, unrelated to the declared submit pattern or
  // the join field.
  for (let i = 0; i < 20; i++) {
    write(
      restCapture({
        method: "GET",
        url: `https://${PRIMARY_HOST}/api/listings/availability`,
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
        url: `https://${PRIMARY_HOST}/api/listings/confirm`,
        requestPostData: JSON.stringify({ itemId }),
        responseBody: { status: "confirmed", itemId },
        timestamp: `2026-08-18T10:24:0${i}.000Z`,
      }),
      `confirm-${itemId}`
    );
  });

  // Declared foldReturn drill target: its URL threads `slotCode`, never the
  // declared join field. `joinFields: ["itemId"]` only ever appears in the
  // response body here, forcing the response-only resolution path over a
  // structural guess.
  write(
    restCapture({
      method: "GET",
      url: `https://${PRIMARY_HOST}/api/listings/detail/slot-2`,
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

describe("recon-generate CLI — full reported defect_shape: early minority-host GraphQL noise, declared submit pattern, declared fold join field", () => {
  it("classifies REST, matches the declared pattern without undercounting, resolves the declared join field, and emits a compiling contract", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-full-reported-scenario-acceptance-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `full-reported-scenario-acceptance-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "check availability" }, { step: "confirm listing", submitStep: true }],
        submitEndpointPattern: "listings/confirm",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [PRIMARY_HOST, SECONDARY_OWN_BACKEND_HOST],
        foldReturn: {
          endpointPattern: "listings/detail",
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

    // Classification: the early-arriving, declared own-backend minority
    // host's real GraphQL captures must never flip REST to GraphQL.
    expect(result.stdout).toContain(`generating plugin for ${siteId} (submission flow,`);
    expect(result.stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);

    // Submit pattern: the declared pattern's real matches must be used, not
    // discarded as a spurious disagreement or undercount against the
    // unfiltered heuristic action sequence.
    expect(combinedOutput).not.toContain("declared submitEndpointPattern/submitBodyPattern");
    expect(combinedOutput).not.toContain("undercount");

    // Fold join field: the declared spec resolves, not a guessed fallback.
    expect(combinedOutput).not.toContain("no fold plan resolved");
    expect(combinedOutput).not.toContain("only structurally-detected fold plans");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).not.toContain("SessionRefresh");
    expect(contract).toContain("listings/confirm");
    expect(contract).toContain("itemId");
    expect(contract).toContain("listings/detail");

    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.recon-full-reported-scenario-acceptance.${process.pid}.json`
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
