import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Reproduces the full reported defect_shape in ONE archive that combines
 * all three misclassification/undercount mechanisms the narrower per-fix
 * tests (test-001 through test-007 in this plan) pin in isolation, plus the
 * non-compiling-output symptom: a dominant primary own-backend REST host, a
 * DECLARED secondary own-backend host firing a real mid-session-redirect
 * GraphQL capture, AND an UNDECLARED subdomain of the primary's own
 * registrable domain (reached only via the derived `fallbackDomain`
 * fallback, never a declared hostname) firing GraphQL-shaped noise. A
 * declared `foldReturn.joinFields` names a field that only ever appears in
 * the primary host's own results/drill-response pairing, never in any
 * request URL/body a structural guess could latch onto instead.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PRIMARY_HOST = "www.desk-catalog-fixture.example.com";
const SECONDARY_OWN_BACKEND_HOST = "auth.desk-catalog-fixture.example.com";
// Same registrable domain (desk-catalog-fixture.example.com) as PRIMARY_HOST,
// but NEVER declared in ownBackendHostnames — it is reachable only through
// the `fallbackDomain` registrable-domain fallback derived from --run-dir's
// captures, mirroring the report's undeclared-subdomain noise exactly.
const UNDECLARED_SUBDOMAIN_HOST = "cdn-widgets.desk-catalog-fixture.example.com";

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
 * A run dir combining, at reduced scale, every strand of the reported
 * archive shape: a large dominant primary-host REST capture set (including
 * genuine matches for the declared submitEndpointPattern), a declared
 * secondary own-backend host's small real GraphQL redirect traffic, and an
 * UNDECLARED same-registrable-domain subdomain's GraphQL-shaped noise.
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

  // Declared secondary own-backend host's real mid-session-redirect
  // GraphQL traffic, fired before the dominant host's own traffic.
  for (let i = 0; i < 2; i++) {
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

  // Undeclared same-registrable-domain subdomain's GraphQL-shaped noise —
  // never named in ownBackendHostnames, reachable only through the derived
  // fallbackDomain path.
  for (let i = 0; i < 2; i++) {
    write(
      graphqlCapture({
        url: `https://${UNDECLARED_SUBDOMAIN_HOST}/graphql`,
        operationName: "WidgetTelemetry",
        query: "query WidgetTelemetry { widgetTelemetry { seen } }",
        responseBody: { data: { widgetTelemetry: { seen: true } } },
        timestamp: `2026-08-18T10:20:2${i}.000Z`,
      }),
      "subdomain-noise"
    );
  }

  // The dominant primary host's listing capture, seeding the item ids the
  // declared foldReturn.resultsPath resolves against.
  write(
    restCapture({
      method: "POST",
      url: `https://${PRIMARY_HOST}/api/catalog/search`,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { results: ITEM_IDS.map((itemId) => ({ itemId })) },
      timestamp: "2026-08-18T10:22:30.000Z",
    }),
    "list-items"
  );

  // Bulk own-backend read noise on the primary host, unrelated to the
  // declared submit pattern or the join field.
  for (let i = 0; i < 20; i++) {
    write(
      restCapture({
        method: "GET",
        url: `https://${PRIMARY_HOST}/api/catalog/availability`,
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
        url: `https://${PRIMARY_HOST}/api/catalog/confirm`,
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
      url: `https://${PRIMARY_HOST}/api/catalog/detail/slot-2`,
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

describe("recon-generate CLI — dominant REST host, declared secondary redirect host, and undeclared same-domain subdomain noise combined", () => {
  it("classifies REST, keeps every declared-pattern submission, resolves the declared fold join field, and emits a compiling contract", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-primary-host-dominant-mixed-noise-classification-fold-submit-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `primary-host-dominant-mixed-noise-fold-submit-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "check availability" }, { step: "confirm item", submitStep: true }],
        submitEndpointPattern: "catalog/confirm",
        requireSubmitEndpointMatch: true,
        // Only the primary and its declared secondary redirect host are
        // named here — UNDECLARED_SUBDOMAIN_HOST is deliberately absent,
        // so it is excluded only via the derived fallbackDomain path.
        ownBackendHostnames: [PRIMARY_HOST, SECONDARY_OWN_BACKEND_HOST],
        foldReturn: {
          endpointPattern: "catalog/detail",
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

    // Symptom 1: classification. Neither the declared secondary redirect
    // host's real GraphQL traffic nor the undeclared subdomain's noise may
    // flip the dominant primary host's REST-majority flow to GraphQL.
    expect(result.stdout).toContain(`generating plugin for ${siteId} (submission flow,`);
    expect(result.stdout).not.toContain("GraphQL");

    // Symptom 2: declared submitEndpointPattern matches must not be
    // discarded as a spurious disagreement/undercount against the
    // unfiltered heuristic action sequence starved by the subdomain noise.
    expect(combinedOutput).not.toContain("disagrees with the unfiltered heuristic action sequence");
    expect(combinedOutput).not.toContain("undercount");

    // Symptom 3: the declared fold join field resolves — not a guessed
    // fallback keyed on the drill URL's own slotCode.
    expect(combinedOutput).not.toContain("no fold plan resolved");
    expect(combinedOutput).not.toContain("only structurally-detected fold plans");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).not.toContain("SessionRefresh");
    expect(contract).not.toContain("WidgetTelemetry");
    expect(contract).toContain("catalog/confirm");
    expect(contract).toContain("itemId");
    expect(contract).toContain("catalog/detail");

    // Symptom 4: the emitted contract compiles cleanly.
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.recon-primary-host-dominant-mixed-noise-fold-submit.${process.pid}.json`
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
