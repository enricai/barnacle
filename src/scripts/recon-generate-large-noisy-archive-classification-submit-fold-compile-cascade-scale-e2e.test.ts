import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Production-scale composite acceptance test: the report states the full
 * cascade only reproduces at archive sizes and shapes close to the real
 * capture volume, not at the ~30-capture scale the existing cascade test
 * (recon-generate-noisy-cross-domain-archive-classification-submit-fold-compile-cascade-e2e.test.ts,
 * left unmodified here) already pins. This generates thousands of captures,
 * two distinct cross-registrable-domain noise hosts interleaved throughout
 * array order, a declared submitEndpointPattern matched by dozens of real
 * captures diluted in that noise, and a declared foldReturn with a
 * double-wildcard nested resultsPath — then asserts all four reported
 * symptoms are fixed together at that scale.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PRIMARY_HOST = "www.widget-catalog-fixture.example.org";
// Two genuinely different registrable domains from PRIMARY_HOST, modeling
// two distinct same-company bounces (SSO + telemetry beacon) that are never
// themselves the flow's own backend.
const AUTH_HOST = "login.widget-auth-fixture.example.net";
const TELEMETRY_HOST = "beacon.widget-telemetry-fixture.example.io";

const GROUP_COUNT = 40;
const UNITS_PER_GROUP = 3;
const ORDER_IDS = Array.from(
  { length: GROUP_COUNT * UNITS_PER_GROUP },
  (_unused, i) => `order-${i}`
);

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

function timestampAt(baseMinute: number, offsetSeconds: number): string {
  const minute = baseMinute + Math.floor(offsetSeconds / 60);
  const second = offsetSeconds % 60;
  return `2026-08-18T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
}

/**
 * A production-scale, noisy archive: thousands of dominant-host captures
 * (listing-read noise, declared-pattern submissions across many groups, and
 * a nested double-wildcard fold drill target) with two distinct
 * cross-registrable-domain noise batches (an auth/SSO host and a telemetry
 * beacon host) interleaved throughout array order at roughly 7-8% of total
 * volume, so neither array-order position nor a single-host carve-out can be
 * the real signal behind classification, submit-pattern matching, or fold
 * resolution.
 */
function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  let index = 0;
  const write = (capture: Capture, label: string): void => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(5, "0")}-${label}.json`),
      JSON.stringify(capture)
    );
    index++;
  };

  const authNoise = (i: number): void =>
    write(
      graphqlCapture({
        url: `https://${AUTH_HOST}/graphql`,
        operationName: "SessionRefresh",
        query: "mutation SessionRefresh($token: String!) { sessionRefresh(token: $token) { ok } }",
        responseBody: { data: { sessionRefresh: { ok: true } } },
        timestamp: timestampAt(20, i * 3),
      }),
      `auth-noise-${i}`
    );

  const telemetryNoise = (i: number): void =>
    write(
      graphqlCapture({
        url: `https://${TELEMETRY_HOST}/graphql`,
        operationName: "BeaconPing",
        query: "mutation BeaconPing($seq: Int!) { beaconPing(seq: $seq) { ok } }",
        responseBody: { data: { beaconPing: { ok: true } } },
        timestamp: timestampAt(21, i * 3),
      }),
      `telemetry-noise-${i}`
    );

  const availabilityNoise = (i: number): void =>
    write(
      restCapture({
        method: "GET",
        url: `https://${PRIMARY_HOST}/api/orders/availability`,
        requestPostData: null,
        responseBody: { slots: [`slot-${i}`] },
        timestamp: timestampAt(22, i),
      }),
      `availability-noise-${i}`
    );

  // Leading noise, both hosts, well before the dominant host's own listing
  // capture — mirrors the report's observation that unrelated bounces fire
  // before the in-flight primary request resolves.
  for (let i = 0; i < 6; i++) {
    authNoise(i);
    telemetryNoise(i);
  }

  // The dominant primary host's listing capture, seeding the nested
  // group/unit structure the declared double-wildcard foldReturn.resultsPath
  // resolves against.
  write(
    restCapture({
      method: "POST",
      url: `https://${PRIMARY_HOST}/api/catalog/search`,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: {
        groups: Array.from({ length: GROUP_COUNT }, (_unused, g) => ({
          groupId: `group-${g}`,
          units: Array.from({ length: UNITS_PER_GROUP }, (_unused2, u) => ({
            orderId: ORDER_IDS[g * UNITS_PER_GROUP + u],
          })),
        })),
      },
      timestamp: timestampAt(23, 0),
    }),
    "list-catalog"
  );

  // Bulk own-backend read noise, unrelated to the declared submit pattern or
  // join field, with both cross-domain noise hosts threaded between chunks
  // of it so no contiguous run of "real" captures exists in array order.
  let noiseCounter = 6;
  for (let i = 0; i < 1700; i++) {
    availabilityNoise(i);
    if (i % 23 === 0) authNoise(noiseCounter++);
    if (i % 29 === 0) telemetryNoise(noiseCounter++);
  }

  // Genuine submissions matching the declared submitEndpointPattern, one per
  // order id (120 real matches), each separated by availability or
  // cross-domain noise so no contiguous run of "real" captures exists.
  ORDER_IDS.forEach((orderId, i) => {
    write(
      restCapture({
        method: "POST",
        url: `https://${PRIMARY_HOST}/api/orders/confirm`,
        requestPostData: JSON.stringify({ orderId }),
        responseBody: { status: "confirmed", orderId },
        timestamp: timestampAt(30, i * 2),
      }),
      `confirm-${orderId}`
    );
    availabilityNoise(1700 + i);
    if (i % 11 === 0) authNoise(noiseCounter++);
    if (i % 13 === 0) telemetryNoise(noiseCounter++);
  });

  // Trailing noise from both hosts after the genuine submissions, proving
  // late-arriving cross-domain traffic from either host can't flip
  // classification either.
  for (let i = 0; i < 6; i++) {
    authNoise(noiseCounter++);
    telemetryNoise(noiseCounter++);
  }

  // Declared foldReturn drill target: its URL threads `slotCode`, never the
  // declared join field. `joinFields: ["orderId"]` only ever appears in the
  // response body here, and the response nests it two levels under a
  // double-wildcard path (`sections.*.entries.*.orderId`), forcing the
  // response-only resolution path to handle BOTH wildcards rather than a
  // structural guess or a single-wildcard shortcut.
  write(
    restCapture({
      method: "GET",
      url: `https://${PRIMARY_HOST}/api/orders/detail/slot-2`,
      requestPostData: null,
      responseBody: {
        sections: [
          {
            sectionId: "section-0",
            entries: [{ orderId: "order-0", slotCode: "slot-0", guests: 2 }],
          },
          {
            sectionId: "section-1",
            entries: [
              { orderId: "order-1", slotCode: "slot-1", guests: 3 },
              { orderId: "order-2", slotCode: "slot-2", guests: 4 },
            ],
          },
        ],
      },
      timestamp: timestampAt(40, 0),
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

describe("recon-generate CLI — production-scale noisy archive with two interleaved cross-domain noise hosts and a double-wildcard declared fold never flips classification, starves the declared submit pattern, or overrides the declared fold join field", () => {
  it("classifies REST, matches the declared-pattern submissions diluted across thousands of captures, resolves the declared double-wildcard join field, and emits a compiling contract with no undeclared identifiers", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-large-noisy-cascade-scale-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `large-noisy-cascade-scale-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "check availability" }, { step: "confirm order", submitStep: true }],
        submitEndpointPattern: "orders/confirm",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [PRIMARY_HOST, AUTH_HOST, TELEMETRY_HOST],
        foldReturn: {
          endpointPattern: "orders/detail",
          resultsPath: "sections.*.entries.*",
          drillResultsPath: "sections.*.entries",
          joinFields: ["orderId"],
        },
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combinedOutput).toBe(0);

    // Symptom #1 — classification: the interleaved, cross-registrable-domain
    // auth and telemetry hosts' real GraphQL captures must never flip REST
    // to GraphQL at production scale, no matter how scattered their
    // array-order positions are across thousands of captures.
    expect(result.stdout).toContain(`generating plugin for ${siteId} (submission flow,`);
    expect(result.stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);
    expect(result.stdout).not.toContain("GraphQL");

    // Symptom #2 — submit pattern: every genuine declared-pattern match
    // across the dominant host's 120 real submissions must be counted, not
    // discarded as "0 capture(s)" or a spurious disagreement against the
    // unfiltered heuristic action sequence starved by the interleaved noise.
    expect(combinedOutput).not.toContain("declared submitEndpointPattern/submitBodyPattern");
    expect(combinedOutput).not.toContain("disagrees with the unfiltered heuristic action sequence");
    expect(combinedOutput).not.toContain("0 capture(s)");
    expect(combinedOutput).not.toContain("undercount");

    // Symptom #3 — fold join field: the declared double-wildcard spec
    // resolves via the real drill response, not a guessed structural
    // fallback keyed on slotCode.
    expect(combinedOutput).not.toContain("no fold plan resolved");
    expect(combinedOutput).not.toContain("only structurally-detected fold plans");
    expect(combinedOutput).not.toContain("declared joinFields were not applied");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    // Symptom #4 (precondition) — no leftover GraphQL client wrapping or
    // either noise host's operation names leaking into the REST contract.
    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).not.toContain("SessionRefresh");
    expect(contract).not.toContain("BeaconPing");
    expect(contract).toContain(PRIMARY_HOST);
    expect(contract).not.toContain(AUTH_HOST);
    expect(contract).not.toContain(TELEMETRY_HOST);
    expect(contract).toContain("orders/confirm");
    expect(contract).toContain("orderId");
    expect(contract).toContain("orders/detail");

    // Symptom #4 — the generated contract.ts must typecheck cleanly, with no
    // undeclared-identifier references, the compile-failure shape the
    // original report observed.
    tsconfigPath = join(REPO_ROOT, `tsconfig.recon-large-noisy-cascade-scale.${process.pid}.json`);
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
  }, 180_000);
});
