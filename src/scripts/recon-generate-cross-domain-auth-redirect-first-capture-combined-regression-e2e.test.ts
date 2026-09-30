import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Reproduces the full reported symptom cluster as one campaign-level
 * acceptance contract: a dominant own-backend REST host whose traffic is
 * vastly outnumbered in array order (never in total count) by a same-company,
 * different-registrable-domain auth/login-style batch that lands early purely
 * due to async completion timing, combined with a declared
 * submitEndpointPattern with genuine matching captures on the dominant host
 * amid own-backend read noise, and a declared foldReturn whose joinFields
 * only resolve via a drill response, never a structural guess. All four
 * reported symptoms (GraphQL misclassification, the declared submit pattern
 * rejected as "0 capture(s)", the declared foldReturn joinFields rejected for
 * a guessed one, and a generated contract.ts referencing an undeclared
 * identifier) trace to this same upstream host-scope/classification decision,
 * so bugfix-001/002/003 must all hold simultaneously for this file to pass.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PRIMARY_HOST = "www.orders-desk-fixture.example.com";
// A genuinely different registrable domain from PRIMARY_HOST, with an
// AUTH_HOST_LABEL-matching first label, modeling a same-company login/SSO
// bounce that is never itself the flow's own backend.
const AUTH_HOST = "login.orders-desk-fixture-id.example.net";

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
 * A run dir where a same-company, different-registrable-domain auth/login
 * host fires real GraphQL-shaped session-refresh captures FIRST -- well
 * outnumbering the dominant host's captures at that point in array order --
 * before the dominant own-backend REST host's much larger total capture
 * count follows, carrying genuine submission captures matching the declared
 * submitEndpointPattern and a drill target whose response body (not its URL)
 * carries the declared foldReturn.joinFields value.
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

  // The cross-registrable-domain auth/login host's real GraphQL traffic --
  // fired FIRST, and outnumbering every dominant-host capture written so far,
  // purely because the SSO bounce resolves before the in-flight primary
  // request does.
  for (let i = 0; i < 8; i++) {
    write(
      graphqlCapture({
        url: `https://${AUTH_HOST}/graphql`,
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
      url: `https://${PRIMARY_HOST}/api/orders/search`,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { results: ITEM_IDS.map((itemId) => ({ itemId })) },
      timestamp: "2026-08-18T10:22:30.000Z",
    }),
    "list-items"
  );

  // Bulk own-backend read noise, unrelated to the declared submit pattern or
  // the join field -- this is what makes the dominant host genuinely
  // dominant by total capture count, despite sorting after the auth batch.
  for (let i = 0; i < 30; i++) {
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

  // Genuine submissions matching the declared submitEndpointPattern -- every
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

  // Declared foldReturn drill target: its URL threads `slotCode`, never the
  // declared join field. `joinFields: ["itemId"]` only ever appears in the
  // response body here, forcing the response-only resolution path over a
  // structural guess.
  write(
    restCapture({
      method: "GET",
      url: `https://${PRIMARY_HOST}/api/orders/detail/slot-2`,
      requestPostData: null,
      responseBody: {
        details: { items: [{ itemId: "item-2", slotCode: "slot-2", guests: 4 }] },
      },
      timestamp: "2026-08-18T10:24:40.000Z",
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

describe("recon-generate CLI — cross-registrable-domain auth/login batch landing first must not flip classification, starve the declared submit pattern, or override the declared fold join field", () => {
  it("classifies REST, matches the declared pattern without undercounting, resolves the declared join field, and emits a compiling contract with no undeclared identifiers", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-cross-domain-first-capture-combined-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `cross-domain-first-capture-combined-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "check availability" }, { step: "confirm order", submitStep: true }],
        submitEndpointPattern: "orders/confirm",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [PRIMARY_HOST, AUTH_HOST],
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

    // Symptom #1 -- classification: the early-arriving, declared
    // different-registrable-domain auth host's real GraphQL captures must
    // never flip REST to GraphQL, no matter how badly it outnumbers the
    // dominant host in array order before the dominant host's traffic
    // arrives.
    expect(result.stdout).toContain(`generating plugin for ${siteId} (submission flow,`);
    expect(result.stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);

    // Symptom #2 -- submit pattern: the declared pattern's real matches on
    // the dominant host must be used, not discarded as "0 capture(s)" or a
    // spurious disagreement against the unfiltered heuristic action sequence.
    expect(combinedOutput).not.toContain("declared submitEndpointPattern/submitBodyPattern");
    expect(combinedOutput).not.toContain("0 capture(s)");
    expect(combinedOutput).not.toContain("undercount");

    // Symptom #3 -- fold join field: the declared spec resolves via the real
    // drill response, not a guessed structural fallback.
    expect(combinedOutput).not.toContain("no fold plan resolved");
    expect(combinedOutput).not.toContain("only structurally-detected fold plans");
    expect(combinedOutput).not.toContain("declared joinFields were not applied");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    // Symptom #4 (precondition) -- no leftover GraphQL client wrapping or
    // auth-host operation names leaking into the REST contract.
    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).not.toContain("SessionRefresh");
    expect(contract).toContain(PRIMARY_HOST);
    expect(contract).not.toContain(AUTH_HOST);
    expect(contract).toContain("orders/confirm");
    expect(contract).toContain("itemId");
    expect(contract).toContain("orders/detail");

    // Symptom #4 -- the generated contract.ts must typecheck cleanly, with no
    // undeclared-identifier references (e.g. a stray *_QUERY constant used
    // but never declared, the compile-failure shape the original report
    // observed).
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.recon-cross-domain-first-capture-combined.${process.pid}.json`
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
