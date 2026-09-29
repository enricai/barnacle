import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Combines all three prior fixes' conditions into one archive so the
 * interaction between them is exercised, not just each fix in isolation:
 * (1) third-party GraphQL noise plus a coincidental REST body field on the
 * own-backend host literally named `operationName`/`query` (populated the
 * same way the live capture pipeline populates those fields off ANY JSON
 * request body, not just genuine GraphQL documents) — neither may flip the
 * REST-majority flow's classification; (2) a declared submitEndpointPattern
 * that must resolve every one of several genuine matches amid heavy
 * own-backend read noise, not an undercounted subset; (3) a declared
 * foldReturn.joinFields that must resolve via the response-only path against
 * a drill target whose URL threads a different field, so a structural guess
 * would pick the wrong join key. Regressing any one of the three fixes
 * reproduces a distinct symptom here even though each has its own narrower
 * test.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PRIMARY_HOST = "www.reservation-desk-fixture.example.com";
const THIRD_PARTY_HOST = "widget.reservation-desk-decoy.example.net";

/**
 * Mirrors flow-runner.ts's real extraction: `operationName`/`query` are
 * populated off ANY parsed JSON request body that happens to carry fields
 * with those names, regardless of whether the traffic is GraphQL.
 */
function restCapture(overrides: {
  method: string;
  url: string;
  requestPostData: string | null;
  responseBody: unknown;
  timestamp: string;
}): Capture {
  const parsed = overrides.requestPostData !== null ? JSON.parse(overrides.requestPostData) : null;
  const operationName =
    parsed && typeof parsed.operationName === "string" ? parsed.operationName : null;
  const query = parsed && typeof parsed.query === "string" ? parsed.query : null;
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
    operationName,
    query,
    variables: parsed?.variables ?? null,
    decodedParams: parsed,
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

const RESERVATION_IDS = ["res-0", "res-1", "res-2"];

/**
 * A run dir where three genuine reservation-confirmation submissions (each
 * matching the declared submitEndpointPattern) are interleaved with bulk
 * own-backend read noise and third-party GraphQL noise, the primary host's
 * own listing capture coincidentally carries `query`/`operationName`-named
 * body fields with plain string values, and a distinct drill endpoint
 * carries the declared foldReturn.joinFields value only in its response
 * body (never in a threaded request field).
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

  // Third-party GraphQL widget noise — unrelated host, fires first, dwarfs
  // the own-backend traffic.
  for (let i = 0; i < 40; i++) {
    write(
      graphqlCapture({
        url: `https://${THIRD_PARTY_HOST}/graphql`,
        operationName: "TrackNoiseEvent",
        query: "mutation TrackNoiseEvent($event: String!) { trackEvent(event: $event) { ok } }",
        responseBody: { data: { trackEvent: { ok: true } } },
        timestamp: `2026-08-18T10:20:${String(i % 60).padStart(2, "0")}.000Z`,
      }),
      "noise-widget"
    );
  }

  // The primary listing capture — its body coincidentally carries fields
  // literally named `query`/`operationName` with ordinary string values (not
  // a GraphQL document), and its `results` array is what the declared
  // foldReturn.resultsPath resolves against, seeding the reservation ids the
  // three genuine confirmations below act on.
  write(
    restCapture({
      method: "POST",
      url: `https://${PRIMARY_HOST}/api/reservations/list`,
      requestPostData: JSON.stringify({
        query: "upcoming",
        operationName: "listReservations",
      }),
      responseBody: {
        results: RESERVATION_IDS.map((reservationId) => ({ reservationId })),
      },
      timestamp: "2026-08-18T10:22:30.000Z",
    }),
    "list-reservations"
  );

  // Bulk own-backend read noise, unrelated to the declared submit pattern or
  // the join field.
  for (let i = 0; i < 20; i++) {
    write(
      restCapture({
        method: "GET",
        url: `https://${PRIMARY_HOST}/api/reservations/availability`,
        requestPostData: null,
        responseBody: { slots: [`slot-${i}`] },
        timestamp: `2026-08-18T10:23:${String(i).padStart(2, "0")}.000Z`,
      }),
      "availability-noise"
    );
  }

  // Three genuine reservation-confirmation submissions — every one must be
  // captured; an undercount would silently drop one or more.
  RESERVATION_IDS.forEach((reservationId, i) => {
    write(
      restCapture({
        method: "POST",
        url: `https://${PRIMARY_HOST}/api/reservations/confirm`,
        requestPostData: JSON.stringify({ reservationId }),
        responseBody: { status: "confirmed", reservationId },
        timestamp: `2026-08-18T10:24:${String(i).padStart(2, "0")}.000Z`,
      }),
      `confirm-${reservationId}`
    );
  });

  // Declared foldReturn drill target: its URL threads the primary
  // reservation's `slotCode`, NOT the declared join field. `joinFields:
  // ["reservationId"]` only ever appears in response bodies here, forcing
  // the response-only resolution path over a structural guess.
  write(
    restCapture({
      method: "GET",
      url: `https://${PRIMARY_HOST}/api/reservations/detail/slot-2`,
      requestPostData: null,
      responseBody: {
        details: { items: [{ reservationId: "res-2", slotCode: "slot-2", guests: 4 }] },
      },
      timestamp: "2026-08-18T10:24:10.000Z",
    }),
    "reservation-detail"
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

describe("recon-generate CLI — REST classification, undercount-free submit pattern, and declared fold join field hold together on one composite archive", () => {
  it("classifies as REST, captures every genuine submission, resolves the declared join field, and emits a compiling contract", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-classification-submit-fold-combined-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `classification-submit-fold-combined-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "check availability" }, { step: "confirm reservation", submitStep: true }],
        submitEndpointPattern: "reservations/confirm",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [PRIMARY_HOST],
        foldReturn: {
          endpointPattern: "reservations/detail",
          resultsPath: "results",
          drillResultsPath: "details.items",
          joinFields: ["reservationId"],
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

    // Classification: neither the third-party GraphQL noise nor the
    // coincidental `query`/`operationName`-named REST body field may flip
    // REST to GraphQL.
    expect(result.stdout).toContain(`generating plugin for ${siteId} (submission flow,`);
    expect(result.stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);

    // Submit pattern: no undercount against the unfiltered heuristic
    // sequence — all three genuine confirmations must survive.
    expect(combinedOutput).not.toContain("declared submitEndpointPattern/submitBodyPattern");
    expect(combinedOutput).not.toContain("undercount");

    // Fold join field: the declared spec resolves, not a guessed fallback.
    expect(combinedOutput).not.toContain("no fold plan resolved");
    expect(combinedOutput).not.toContain("only structurally-detected fold plans");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).not.toContain(THIRD_PARTY_HOST);
    expect(contract).not.toContain("TrackNoiseEvent");
    expect(contract).toContain("reservations/confirm");
    expect(contract).toContain("reservationId");
    expect(contract).toContain("reservations/detail");

    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.recon-classification-submit-fold-combined.${process.pid}.json`
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
