import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addSeconds } from "date-fns";
import { afterEach, describe, expect, it } from "vitest";

import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the fix in `isGraphQL`'s REST anti-vote pool: a flow whose real
 * own-backend evidence is almost entirely POST/PUT/PATCH submissions (no
 * `.query`/`operationName`, no GET captures to anchor the pre-fix GET-only
 * anti-vote) must still classify as REST against a small minority of
 * genuinely-parsed GraphQL captures, and must resolve its declared
 * submitEndpointPattern/foldReturn joinFields against its real matching
 * captures.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.post-majority-cascade-fixture.example.com";
const UPDATE_URL = `https://${OWN_BACKEND_HOST}/booking/status-update/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/booking/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/booking/confirm/`;
const GRAPHQL_URL = `https://${OWN_BACKEND_HOST}/graphql`;

const BASE_TIMESTAMP = new Date("2026-08-19T09:12:00.000Z");
const JOIN_VALUE = "BOOKING-JOIN-KEY-01";
const SUBMIT_FIELD_VALUE = "BOOKING-CONFIRMATION-TOKEN-01";
const POST_NOISE_COUNT = 900;
const SUBMIT_COUNT = 3;
const GENUINE_GRAPHQL_COUNT = 3;

// Bulk own-backend REST evidence: PATCH status-update submissions, no `.query`
// or `operationName`, and deliberately zero GET captures so this pool is the
// only thing that can anchor REST classification -- the exact shape the
// pre-fix GET-only anti-vote filter made invisible.
function postNoiseCaptures(): Capture[] {
  return Array.from({ length: POST_NOISE_COUNT }, (_unused, index) =>
    buildCapture({
      method: "PATCH",
      url: UPDATE_URL,
      requestPostData: JSON.stringify({ bookingId: `booking-${index}`, status: "confirmed" }),
      responseBody: { ok: true },
      timestamp: addSeconds(BASE_TIMESTAMP, index).toISOString(),
    })
  );
}

// The declared foldReturn's seed listing: threads the real join value so the
// drill capture below has a real key to resolve against.
function listCapture(): Capture {
  return buildCapture({
    method: "POST",
    url: UPDATE_URL,
    requestPostData: JSON.stringify({ bookingId: JOIN_VALUE, status: "pending" }),
    responseBody: { results: [{ bookingId: JOIN_VALUE }] },
    timestamp: addSeconds(BASE_TIMESTAMP, POST_NOISE_COUNT).toISOString(),
  });
}

// The declared foldReturn's drill target: a genuine drill-down capture whose
// response body carries the declared join field's real matching value.
function drillCapture(): Capture {
  return buildCapture({
    method: "POST",
    url: DRILL_URL,
    requestPostData: JSON.stringify({ bookingId: JOIN_VALUE }),
    responseBody: { bookingId: JOIN_VALUE, price: 88 },
    timestamp: addSeconds(BASE_TIMESTAMP, POST_NOISE_COUNT + 1).toISOString(),
  });
}

// Real dominant matches against the declared submitEndpointPattern: every one
// must be captured, not an undercounted subset.
function submitCaptures(): Capture[] {
  return Array.from({ length: SUBMIT_COUNT }, (_unused, index) =>
    buildCapture({
      method: "POST",
      url: SUBMIT_URL,
      requestPostData: JSON.stringify({
        bookingId: JOIN_VALUE,
        confirmationToken: `${SUBMIT_FIELD_VALUE}-${index}`,
      }),
      responseBody: { ok: true },
      timestamp: addSeconds(BASE_TIMESTAMP, POST_NOISE_COUNT + 2 + index).toISOString(),
    })
  );
}

// The reported minority: a small recurring endpoint whose captures are
// genuinely-parsed GraphQL documents (real `operationName`/`query` off an
// actual request body), trivially dominating the tiny has-`.query` subset
// while remaining a small minority of the archive's real own-backend
// traffic overall. This must not flip the flow's classification.
function genuineGraphQLCaptures(): Capture[] {
  const operationName = "searchBookings";
  const query =
    "query searchBookings($filter: String) { searchBookings(filter: $filter) { id status } }";
  return Array.from({ length: GENUINE_GRAPHQL_COUNT }, (_unused, index) => ({
    timestamp: addSeconds(BASE_TIMESTAMP, POST_NOISE_COUNT + 100 + index).toISOString(),
    phase: "search-bookings",
    method: "POST",
    url: GRAPHQL_URL,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ operationName, query, variables: { filter: "all" } }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { searchBookings: [{ id: JOIN_VALUE, status: "confirmed" }] },
    operationName,
    query,
    variables: { filter: "all" },
    decodedParams: null,
  }));
}

function fixtureCaptures(): Capture[] {
  return [
    ...postNoiseCaptures(),
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

describe("recon-generate CLI — POST-majority own-backend REST traffic, genuine GraphQL minority, submit pattern, and fold join cascade", () => {
  it("classifies as REST with no GET anti-vote evidence, resists the genuine GraphQL minority, resolves the declared submit pattern and fold join key, and emits a compiling contract", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    const captures = fixtureCaptures();
    expect(captures.length).toBeGreaterThanOrEqual(900);
    expect(captures.every((capture) => capture.method !== "GET")).toBe(true);

    workDir = mkdtempSync(join(tmpdir(), "barnacle-post-majority-cascade-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, captures);

    const siteId = `post-majority-cascade-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse booking status updates" },
          { step: "open booking detail panel" },
          { step: "submit booking confirmation", submitStep: true },
        ],
        submitEndpointPattern: "booking/confirm",
        requireSubmitEndpointMatch: true,
        foldReturn: {
          endpointPattern: "booking/detail",
          resultsPath: "results",
          drillResultsPath: "bookingId",
          joinFields: ["bookingId"],
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
    expect(contract).toContain("booking/confirm");
    expect(contract).toContain("confirmationToken");
    expect(contract).toContain("booking/detail");

    tsconfigPath = join(REPO_ROOT, `tsconfig.post-majority-cascade.${process.pid}.json`);
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
