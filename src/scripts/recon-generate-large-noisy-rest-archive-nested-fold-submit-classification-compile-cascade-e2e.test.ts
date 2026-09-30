import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Production-scale reproduction of the reported cascade (recon-generate
 * misclassifying a REST archive as GraphQL, rejecting a declared
 * submitEndpointPattern despite real matches, rejecting a declared foldReturn
 * in favor of a structural guess, and emitting a contract.ts that does not
 * compile), built at the archive's actual shape rather than the existing
 * ~40-capture `recon-generate-noisy-cross-domain-archive-classification-submit-
 * fold-compile-cascade-e2e.test.ts` fixture's scale:
 *
 * - several thousand captures total (not a few dozen);
 * - a real submission endpoint pattern with EIGHTEEN literal URL matches,
 *   scattered singly through the archive rather than as one contiguous run;
 * - a declared foldReturn whose `resultsPath` is a TWO-level wildcard
 *   (`locations.*.categories.*.vehicles`) resolving inside a SINGLE capture's
 *   own nested response body — the listing capture IS the endpointPattern
 *   match, not a separate later drill-down call — unlike the existing
 *   fixture's flat single-array primary joined against an independent
 *   drill endpoint;
 * - a several-hundred-capture cross-domain SSO/session-refresh noise block
 *   interleaved one-by-one throughout array order, not confined to a
 *   contiguous block.
 *
 * This test asserts the CORRECT end state (REST classification, every
 * declared-pattern match counted, the declared fold resolved, a compiling
 * contract) — it is a red test today, not a green one, so it can gate the
 * bugfix subtasks that must turn it green.
 *
 * Direct reproduction runs against the current tree (see PROJECT_MEMORY /
 * investigation for this run) found TWO of the four reported symptoms still
 * live at this scale/shape — the declared submitEndpointPattern is discarded
 * as "0 capture(s)" despite eighteen genuine matches, and the declared
 * foldReturn is rejected in favor of "no fold plan resolved" — so this test
 * currently fails on exactly those two assertions. The other two reported
 * symptoms (GraphQL misclassification and the resulting undeclared-identifier
 * compile failure) do NOT reproduce at this scale/shape: the cross-domain
 * host-anchoring fixes already on this tree (`deriveBaseUrl`'s primary-host
 * anchoring and `isGraphQL`'s REST anti-vote widening) exclude the noise host
 * from the classification vote entirely once a dominant own-backend host is
 * established, regardless of the noise block's size or interleaving. The
 * classification and compile assertions below therefore already pass today,
 * standing as regression guards that those two fixes keep holding at this
 * larger scale.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PRIMARY_HOST = "api.fleet-rental-fixture.example.org";
// A genuinely different registrable domain from PRIMARY_HOST, modeling the
// real report's mid-session SSO/login bounce — never itself the flow's own
// submission backend.
const AUTH_HOST = "sso.fleet-portal-fixture.example.net";

const RESERVE_COUNT = 18;
const RESERVATION_IDS = Array.from({ length: RESERVE_COUNT }, (_, i) => `reservation-${i}`);

// Deterministic LCG shuffle so the noise interleaving is reproducible across
// runs without pulling in a randomness dependency.
function seededShuffle<T>(items: T[], seed: number): T[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

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
 * A production-scale, noisy archive: one listing capture whose response
 * nests its per-item array TWO wildcard levels deep (mirroring the report's
 * `products.*.itineraries.*.sailings`), eighteen genuine submission captures
 * matching the declared `reserve-vehicle` pattern, ~3,000 own-backend browse
 * captures, and a ~400-capture cross-domain SSO noise block — all shuffled
 * together so no contiguous run of "real" or "noise" captures exists in
 * array order.
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

  let tick = 0;
  const nextTimestamp = (): string => {
    tick++;
    return new Date(Date.UTC(2026, 7, 18, 10, 0, 0) + tick * 1000).toISOString();
  };

  const authNoise = (): Capture =>
    graphqlCapture({
      url: `https://${AUTH_HOST}/graphql`,
      operationName: "SessionRefresh",
      query: "mutation SessionRefresh($token: String!) { sessionRefresh(token: $token) { ok } }",
      responseBody: { data: { sessionRefresh: { ok: true } } },
      timestamp: nextTimestamp(),
    });

  const browseNoise = (i: number): Capture =>
    restCapture({
      method: "GET",
      url: `https://${PRIMARY_HOST}/api/fleet/browse?page=${i}`,
      requestPostData: null,
      responseBody: { items: [`vehicle-noise-${i}`] },
      timestamp: nextTimestamp(),
    });

  // The dominant primary host's listing capture: its own response nests the
  // fold target TWO wildcard levels deep, and it is ITSELF the capture the
  // declared foldReturn's endpointPattern matches — a single-capture
  // self-fold, not a separate later drill-down call.
  const locations = Array.from({ length: 4 }, (_, l) => ({
    locationId: `location-${l}`,
    categories: Array.from({ length: 3 }, (_, c) => ({
      categoryId: `category-${l}-${c}`,
      vehicles: Array.from({ length: 2 }, (_, v) => ({
        vehicleId: `vehicle-${l}-${c}-${v}`,
        dailyRate: 40 + v,
      })),
    })),
  }));
  write(
    restCapture({
      method: "GET",
      url: `https://${PRIMARY_HOST}/api/fleet/fleet-availability?market=west`,
      requestPostData: null,
      responseBody: { locations },
      timestamp: nextTimestamp(),
    }),
    "listing-nested-two-level-wildcard"
  );

  // Eighteen genuine submissions matching the declared submitEndpointPattern.
  const queue: Array<{ label: string; capture: Capture }> = RESERVATION_IDS.map(
    (reservationId) => ({
      label: `reserve-${reservationId}`,
      capture: restCapture({
        method: "POST",
        url: `https://${PRIMARY_HOST}/api/fleet/reserve-vehicle`,
        requestPostData: JSON.stringify({ reservationId }),
        responseBody: { status: "confirmed", reservationId },
        timestamp: nextTimestamp(),
      }),
    })
  );

  // ~3,000 own-backend read noise plus a ~400-capture cross-domain SSO noise
  // block, both threaded into the same queue as the genuine submissions so
  // the shuffle below interleaves everything.
  const BROWSE_NOISE_COUNT = 3000;
  const AUTH_NOISE_STRIDE = 8; // yields ~375 interleaved auth captures
  for (let i = 0; i < BROWSE_NOISE_COUNT; i++) {
    queue.push({ label: `browse-noise-${i}`, capture: browseNoise(i) });
    if (i % AUTH_NOISE_STRIDE === 0) {
      queue.push({ label: `auth-noise-${i}`, capture: authNoise() });
    }
  }

  seededShuffle(queue, 42);
  for (const { label, capture } of queue) write(capture, label);
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

describe("recon-generate CLI — production-scale noisy REST archive with an 18-match submit pattern and a two-level-wildcard self-fold", () => {
  it("classifies REST, counts every declared-pattern submission, resolves the declared two-level-wildcard self-fold, and emits a compiling contract", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-large-noisy-cascade-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `large-noisy-cascade-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "browse fleet" }, { step: "reserve vehicle", submitStep: true }],
        submitEndpointPattern: "reserve-vehicle",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [PRIMARY_HOST, AUTH_HOST],
        foldReturn: {
          endpointPattern: "fleet-availability",
          resultsPath: "locations.*.categories.*.vehicles",
          joinFields: ["vehicleId"],
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

    // Classification regression guard: the report's cross-domain
    // misclassification does NOT reproduce at this scale — verified fixed by
    // deriveBaseUrl's primary-host anchoring and isGraphQL's REST anti-vote
    // widening, which exclude the noise host from the vote entirely once a
    // dominant own-backend host is established. A regression here would flip
    // this assertion, not the two below.
    expect(result.stdout).toContain(`generating plugin for ${siteId} (single-endpoint REST,`);
    expect(result.stdout).not.toContain("GraphQL");

    // Symptom #2 (still live at this scale) — every one of the submit
    // pattern's eighteen genuine matches, scattered singly (never
    // contiguous) through ~3,400 captures, must be counted, not discarded as
    // "0 capture(s)" against the unfiltered heuristic sequence.
    expect(combinedOutput).not.toContain("declared submitEndpointPattern/submitBodyPattern");
    expect(combinedOutput).not.toContain("disagrees with the unfiltered heuristic action sequence");
    expect(combinedOutput).not.toContain("0 capture(s)");

    // Symptom #3 (still live at this scale) — the declared foldReturn's
    // two-level-wildcard, single-capture self-fold (the listing capture is
    // itself the endpointPattern match, not a separate drill-down call) must
    // resolve via the declared joinFields, not be rejected in favor of "no
    // fold plan resolved" or a structurally-guessed join key.
    expect(combinedOutput).not.toContain("no fold plan resolved");
    expect(combinedOutput).not.toContain("only structurally-detected fold plans");
    expect(combinedOutput).not.toContain("declared joinFields were not applied");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");
    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).not.toContain("SessionRefresh");
    expect(contract).toContain(PRIMARY_HOST);
    expect(contract).not.toContain(AUTH_HOST);
    expect(contract).toContain("reserve-vehicle");
    expect(contract).toContain("vehicleId");
    expect(contract).toContain("fleet-availability");

    // Compile regression guard: with classification staying REST, the
    // report's undeclared-identifier compile failure (tied to the rejected
    // GraphQL emission path) does not reproduce either — the emitted
    // contract.ts must still typecheck cleanly.
    tsconfigPath = join(REPO_ROOT, `tsconfig.recon-large-noisy-cascade.${process.pid}.json`);
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
