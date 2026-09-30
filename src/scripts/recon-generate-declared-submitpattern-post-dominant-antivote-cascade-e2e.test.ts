import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addSeconds } from "date-fns";
import { afterEach, describe, expect, it } from "vitest";

import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Proves the full reported cascade closes together for a POST-dominant
 * archive that carries no genuinely-parsed GraphQL documents at all: REST
 * classification must stand on the POST anti-vote pool alone (dozens of
 * own-backend captures, zero GETs to supply the pre-fix anti-vote), one
 * coincidentally-parseable GET capture must not tip classification, and the
 * declared submitEndpointPattern/foldReturn joinFields must resolve against
 * real matching captures rather than logging a guessed key or "0 capture(s)".
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.submitpattern-antivote-cascade-fixture.example.com";
const UPDATE_URL = `https://${OWN_BACKEND_HOST}/widget/status-update/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/widget/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/widget/confirm/`;
const COINCIDENTAL_URL = `https://${OWN_BACKEND_HOST}/widget/search-terms/`;

const BASE_TIMESTAMP = new Date("2026-08-19T09:12:00.000Z");
const JOIN_VALUE = "WIDGET-JOIN-KEY-01";
const SUBMIT_FIELD_VALUE = "WIDGET-CONFIRMATION-TOKEN-01";
const POST_NOISE_COUNT = 40;
const DRILL_COUNT = 5;
const SUBMIT_COUNT = 3;

// Dozens of own-backend POST captures: no `.query`, no `operationName`, and
// the only source of REST anti-vote weight in this fixture — the archive is
// deliberately starved of GET traffic so the pre-fix GET-only anti-vote
// filter would have seen nothing to anchor REST classification on.
function postNoiseCaptures(): Capture[] {
  return Array.from({ length: POST_NOISE_COUNT }, (_unused, index) =>
    buildCapture({
      method: "POST",
      url: UPDATE_URL,
      requestPostData: JSON.stringify({ widgetId: `widget-${index}`, status: "updated" }),
      responseBody: { ok: true },
      timestamp: addSeconds(BASE_TIMESTAMP, index).toISOString(),
    })
  );
}

// Small number of same-host GET drill-down captures whose response carries
// the declared foldReturn joinFields value, so the fold plan has real
// matching captures to resolve against instead of a guessed structural key.
function drillCaptures(): Capture[] {
  return Array.from({ length: DRILL_COUNT }, (_unused, index) =>
    buildCapture({
      method: "GET",
      url: `${DRILL_URL}?widgetId=${JOIN_VALUE}-${index}`,
      requestPostData: null,
      responseBody: { widgetId: JOIN_VALUE, price: 12 + index },
      timestamp: addSeconds(BASE_TIMESTAMP, POST_NOISE_COUNT + index).toISOString(),
    })
  );
}

function listCapture(): Capture {
  return buildCapture({
    method: "POST",
    url: UPDATE_URL,
    requestPostData: JSON.stringify({ widgetId: JOIN_VALUE, status: "pending" }),
    responseBody: { results: [{ widgetId: JOIN_VALUE }] },
    timestamp: addSeconds(BASE_TIMESTAMP, POST_NOISE_COUNT + DRILL_COUNT).toISOString(),
  });
}

// Real dominant matches against the declared submitEndpointPattern: every
// one must be captured, not an undercounted subset that logs "0 capture(s)".
function submitCaptures(): Capture[] {
  return Array.from({ length: SUBMIT_COUNT }, (_unused, index) =>
    buildCapture({
      method: "POST",
      url: SUBMIT_URL,
      requestPostData: JSON.stringify({
        widgetId: JOIN_VALUE,
        confirmationToken: `${SUBMIT_FIELD_VALUE}-${index}`,
      }),
      responseBody: { ok: true },
      timestamp: addSeconds(
        BASE_TIMESTAMP,
        POST_NOISE_COUNT + DRILL_COUNT + 1 + index
      ).toISOString(),
    })
  );
}

// The reported minority: a single GET capture whose `query` field textually
// satisfies parsedOperationName's regex without being any kind of real
// GraphQL document. Against a votingPool otherwise dominated by the POST
// anti-vote pool, this one coincidental parse must not flip classification.
function coincidentalQueryFieldCapture(): Capture {
  const queryValue = "query CatalogSearch for handmade widgets";
  return {
    timestamp: addSeconds(
      BASE_TIMESTAMP,
      POST_NOISE_COUNT + DRILL_COUNT + 1 + SUBMIT_COUNT
    ).toISOString(),
    phase: "action",
    method: "GET",
    url: COINCIDENTAL_URL,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { results: [] },
    operationName: null,
    query: queryValue,
    variables: null,
    decodedParams: null,
  };
}

function fixtureCaptures(): Capture[] {
  return [
    ...postNoiseCaptures(),
    ...drillCaptures(),
    listCapture(),
    ...submitCaptures(),
    coincidentalQueryFieldCapture(),
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

describe("recon-generate CLI — declared submitEndpointPattern/foldReturn resolve against a POST-dominant anti-vote pool", () => {
  it("classifies as REST on POST anti-vote weight alone, resists the coincidental query-field capture, resolves the declared submit pattern and fold join key, and emits a compiling contract", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    const captures = fixtureCaptures();
    expect(captures.filter((capture) => capture.method === "GET").length).toBe(DRILL_COUNT + 1);
    expect(captures.filter((capture) => capture.method === "POST").length).toBeGreaterThanOrEqual(
      POST_NOISE_COUNT
    );

    workDir = mkdtempSync(join(tmpdir(), "barnacle-submitpattern-antivote-cascade-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, captures);

    const siteId = `submitpattern-antivote-cascade-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse widget status updates" },
          { step: "open widget detail panel" },
          { step: "submit widget confirmation", submitStep: true },
        ],
        submitEndpointPattern: "widget/confirm",
        requireSubmitEndpointMatch: true,
        foldReturn: {
          endpointPattern: "widget/detail",
          resultsPath: "results",
          drillResultsPath: "widgetId",
          joinFields: ["widgetId"],
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
    expect(out).toContain(`generating plugin for ${siteId} (submission flow`);
    expect(out).not.toContain(`generating plugin for ${siteId} (GraphQL,`);
    expect(out).not.toContain("disagrees with the unfiltered heuristic");
    expect(out).not.toContain("declared spec resolved no fold plan");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");
    expect(contract).toContain("widget/confirm");
    expect(contract).toContain("confirmationToken");
    expect(contract).toContain("widget/detail");

    tsconfigPath = join(REPO_ROOT, `tsconfig.submitpattern-antivote-cascade.${process.pid}.json`);
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
