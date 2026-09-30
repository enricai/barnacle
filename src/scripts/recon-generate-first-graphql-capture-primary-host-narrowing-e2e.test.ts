import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Locks in `firstGraphQLCapture`'s `primaryHost` narrowing end to end for the
 * NO-`ownBackendHostnames`-declared case: both hosts are undeclared and pass
 * gating purely via `fallbackDomain` (same registrable domain as the derived
 * base URL), unlike the sibling
 * recon-generate-graphql-fallback-primary-host-narrowing-e2e.test.ts, which
 * declares both hosts in `ownBackendHostnames` and forces the fallback path
 * via a flow-declared `submitEndpointPattern`/`submitBodyPattern`. Here no
 * submit pattern is declared at all — the genuine mutation capture on the
 * primary host is enough on its own to null out `selectPrimaryGraphQLOperation`
 * (via `graphqlActionSequenceHasMutation`) and push generation onto
 * `firstGraphQLCapture`'s raw fallback path.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PRIMARY_HOST = "catalog.fallback-narrowing-fixture.example.com";
const MINORITY_HOST = "cdn.catalog.fallback-narrowing-fixture.example.com";

const MINORITY_QUERY =
  "query MinorityWidgets($filters: String) { minorityWidgets(filters: $filters) { id } }";
const PRIMARY_QUERY =
  "query SearchResults($filters: String) { results(filters: $filters) { id name } }";

// Chronologically first, on the minority undeclared-subdomain host — an
// ungated candidate[0] fallback would resolve everything to this capture.
function minorityHostCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "browse",
    method: "POST",
    url: `https://${MINORITY_HOST}/graphql`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    operationName: null,
    query: MINORITY_QUERY,
    variables: { filters: "category:widgets" },
    responseBody: { minorityWidgets: [{ id: "cdn-1" }] },
    decodedParams: null,
  };
}

// The dominant (primary) host's genuine search — sent AFTER the minority
// host's capture, and outnumbering it so deriveBaseUrl resolves PRIMARY_HOST
// as the flow's primaryHost.
function primaryHostCapture(index: number): Capture {
  return {
    timestamp: `2026-01-01T00:10:${String(index).padStart(2, "0")}.000Z`,
    phase: "filter",
    method: "POST",
    url: `https://${PRIMARY_HOST}/graphql`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    operationName: null,
    query: PRIMARY_QUERY,
    variables: { filters: "category:widgets" },
    responseBody: {
      results: Array.from({ length: 3 }, (_, i) => ({ id: `${index}-${i}`, name: `Widget ${i}` })),
    },
    decodedParams: null,
  };
}

// The single genuine mutation capture on the primary host — with no
// submitEndpointPattern/submitBodyPattern declared, this is what forces
// extractGraphQLActionSequence non-empty-with-a-mutation, nulling
// primaryGraphQLOperation and pushing generation onto firstGraphQLCapture's
// raw fallback path under test.
function primaryMutationCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:20:00.000Z",
    phase: "filter",
    method: "POST",
    url: `https://${PRIMARY_HOST}/graphql`,
    status: 200,
    requestHeaders: {},
    requestPostData: "mutation logSearchImpression { logSearchImpression(input: {}) { ok } }",
    responseHeaders: { "content-type": "application/json" },
    operationName: "logSearchImpression",
    query: "mutation logSearchImpression { logSearchImpression(input: {}) { ok } }",
    variables: null,
    responseBody: { logSearchImpression: { ok: true } },
    decodedParams: null,
  };
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

describe("recon-generate CLI — firstGraphQLCapture primaryHost narrowing with no declared ownBackendHostnames/submitEndpointPattern", () => {
  it("resolves query/endpoint/operationName to the dominant primary-host capture, excluding the undeclared minority subdomain's earlier-sorting capture on the same registrable domain", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-first-graphql-capture-primary-host-narrowing-e2e-")
    );
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    const primarySearchCaptures = Array.from({ length: 2 }, (_, i) => primaryHostCapture(i));
    const allCaptures = [minorityHostCapture(), ...primarySearchCaptures, primaryMutationCapture()];
    allCaptures.forEach((capture, index) => {
      const filename = `${String(index).padStart(3, "0")}-capture.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
    });

    const siteId = `first-graphql-capture-primary-host-narrowing-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "select 'widgets' from the Category filter", payloadField: "category" },
          { step: "verify the filtered results are visible", submitStep: true },
        ],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The endpoint, embedded query text, and operationName literal must all
    // resolve to the dominant PRIMARY_HOST capture.
    expect(contract).toContain(PRIMARY_HOST);
    expect(contract).toContain("SearchResults");
    expect(contract).toContain("results(filters: $filters)");

    // The minority undeclared-subdomain host's capture must never win the
    // fallback, even though it shares the same registrable domain (passing
    // fallbackDomain gating) and sorts chronologically first.
    expect(contract).not.toContain(MINORITY_HOST);
    expect(contract).not.toContain("MinorityWidgets");
    expect(contract).not.toContain("minorityWidgets");

    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.recon-first-graphql-capture-primary-host.${process.pid}.json`
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
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
