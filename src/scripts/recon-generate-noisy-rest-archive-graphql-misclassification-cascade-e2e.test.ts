import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Reproduces the full reported cascade as one acceptance test: a REST/JSON
 * flow with a declared submitEndpointPattern that has real dominant matching
 * captures, a declared foldReturn whose joinFields resolve against real
 * drill-down captures, one minority capture whose query field's text
 * coincidentally satisfies the operation-name regex, and a large batch of
 * unrelated same-domain noise mirroring the archive's real mid-session
 * redirect noise. bugfix-001 (recon-generate-coincidental-query-field-*
 * e2e tests) and bugfix-002 (deriveBaseUrl's parsedOperationName fix) each
 * fix one boundary of this cascade in isolation; this test is the single
 * checkable proof they close all four reported symptoms together, not a
 * duplicate of either narrower test.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.noisy-rest-archive-cascade-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;
const REDIRECT_NOISE_URL = `https://${OWN_BACKEND_HOST}/session/refresh/`;

const JOIN_VALUE = "ITEM-JOIN-KEY-01";
const SUBMIT_FIELD_VALUE = "ORDER-CONFIRMATION-TOKEN-01";
const NOISE_COUNT = 900;

function listCapture(): Capture {
  return buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ page: 1 }),
    responseBody: { results: [{ itemId: JOIN_VALUE }] },
    timestamp: "2026-05-01T00:00:00Z",
  });
}

function drillCapture(): Capture {
  return buildCapture({
    url: `${DRILL_URL}?itemId=${JOIN_VALUE}`,
    requestPostData: null,
    responseBody: { itemId: JOIN_VALUE, price: 42 },
    method: "GET",
    timestamp: "2026-05-01T00:00:01Z",
  });
}

function submitCapture(): Capture {
  return buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({ itemId: JOIN_VALUE, confirmationToken: SUBMIT_FIELD_VALUE }),
    responseBody: { ok: true },
    timestamp: "2026-05-01T00:00:02Z",
  });
}

function restSearchTermCapture(index: number, queryValue: string): Capture {
  return {
    timestamp: `2026-05-01T00:00:0${3 + index}Z`,
    phase: "action",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/catalog/search-terms/`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: queryValue }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { results: [] },
    operationName: null,
    query: queryValue,
    variables: null,
    decodedParams: null,
  };
}

// The rest of isGraphQL's query-bearing voting pool: ordinary REST search
// terms that never satisfy parsedOperationName's regex, so the coincidental
// capture below is a real 1-in-6 minority of that pool, not its entirety.
function plainSearchTermCaptures(): Capture[] {
  return ["lamp", "chair", "desk", "shelf", "mirror"].map((term, index) =>
    restSearchTermCapture(index, term)
  );
}

// The reported minority capture: an ordinary REST body field whose VALUE
// textually starts with `query <Word>`, satisfying parsedOperationName's
// regex without being any kind of GraphQL document.
function coincidentalQueryFieldCapture(): Capture {
  return restSearchTermCapture(5, "query CatalogSearch for handmade lamps");
}

// A large batch of same-domain but unrelated noise, mirroring the archive's
// real, unplanned mid-session redirect noise rather than a third-party host.
function redirectNoiseCaptures(): Capture[] {
  return Array.from({ length: NOISE_COUNT }, (_unused, index) =>
    buildCapture({
      url: REDIRECT_NOISE_URL,
      requestPostData: null,
      responseBody: { sessionToken: `session-${index}-${Math.random()}` },
      timestamp: `2026-05-01T00:01:${String(index % 60).padStart(2, "0")}Z`,
    })
  );
}

function fixtureCaptures(): Capture[] {
  return [
    listCapture(),
    drillCapture(),
    submitCapture(),
    ...plainSearchTermCaptures(),
    coincidentalQueryFieldCapture(),
    ...redirectNoiseCaptures(),
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

describe("recon-generate CLI — noisy REST archive misclassification cascade", () => {
  it("honors the declared submit pattern and fold plan, resists the coincidental query-field minority, and typechecks clean", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }

    const captures = fixtureCaptures();
    expect(captures.length).toBeGreaterThanOrEqual(900);

    workDir = mkdtempSync(join(tmpdir(), "barnacle-noisy-rest-archive-cascade-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, captures);

    const siteId = `noisy-rest-archive-cascade-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
          { step: "open item detail panel" },
          { step: "submit item selection", submitStep: true },
        ],
        submitEndpointPattern: "catalog/submit",
        requireSubmitEndpointMatch: true,
        foldReturn: {
          endpointPattern: "catalog/detail",
          resultsPath: "results",
          drillResultsPath: "itemId",
          joinFields: ["itemId"],
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
    expect(out).not.toContain(`generating plugin for ${siteId} (GraphQL,`);
    expect(out).not.toContain("disagrees with the unfiltered heuristic");
    expect(out).not.toContain("declared spec resolved no fold plan");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");
    expect(contract).toContain("catalog/submit");
    expect(contract).toContain("confirmationToken");
    expect(contract).toContain("catalog/detail");
    expect(contract).not.toContain("session/refresh");

    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    tsconfigPath = join(REPO_ROOT, `tsconfig.noisy-rest-archive-cascade.${process.pid}.json`);
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
