import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Two independently reached checks tied to the same `isGqlEmission = gql &&
 * gqlQuery !== null` chokepoint emitContractTs's own doc comment names as
 * the single source of truth for every GraphQL-emission decision:
 *
 * 1. `emitContractTs` itself, driven directly with the REST-fallback shape
 *    (`gql: true`, `gqlQuery: null`) that the audit flagged as the one
 *    `buildContractChecklist` used to bypass, must emit a contract.ts with
 *    no undeclared `_QUERY` reference and must typecheck clean. Tracing
 *    `isGraphQL()` / `firstGraphQLCapture()` (recon-generate.ts:1500,1550)
 *    shows `firstGraphQLCapture` always falls back to its full candidate
 *    pool when no submit-pattern match exists (`restrictToSubmitPattern`,
 *    recon-generate.ts:2009) rather than emptying it, so `gql: true` with
 *    `gqlQuery: null` is not reachable by driving the real CLI over
 *    captures alone as of current HEAD — this drives `emitContractTs`
 *    directly instead, which is the only way to exercise the shape and
 *    still pin real `tsc` compile-parity on the chokepoint.
 * 2. A real CLI run over a noisy REST archive shaped like report item 4
 *    (an own-backend capture with a bare operation label but no capture on
 *    the flow ever carrying real query text) re-confirms, on current HEAD,
 *    that generation falls through to REST emission and the symptom no
 *    longer reproduces — the audit noted this had not been re-verified
 *    past 1.12.71.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

let tsconfigPaths: string[] = [];

afterEach(() => {
  for (const path of tsconfigPaths) rmSync(path, { force: true });
  tsconfigPaths = [];
});

function assertTypechecksClean(label: string, includeGlob: string): void {
  if (!existsSync(TSC_BIN)) {
    throw new Error("tsc not installed — cannot verify the emitted source compiles");
  }
  const tsconfigPath = join(REPO_ROOT, `tsconfig.gql-emission-decision-parity.${label}.json`);
  tsconfigPaths.push(tsconfigPath);
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
      include: [includeGlob],
    })
  );
  const check = spawnSync(TSC_BIN, ["-p", tsconfigPath, "--noEmit"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const diagnostics = `${check.stdout}\n${check.stderr}`;
  expect(check.status, diagnostics).toBe(0);
}

describe("emitContractTs — REST-fallback-after-gql-true (isGqlEmission chokepoint) compiles clean", () => {
  it("emits no undeclared _QUERY reference and typechecks clean for gql=true/gqlQuery=null", () => {
    const siteId = `gql-emission-decision-unit-test${process.pid}`;
    const source = emitContractTs({
      siteId,
      pascal: "GqlEmissionDecisionFixture",
      baseUrl: "https://www.gql-emission-decision-parity-fixture.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { id: "abc", active: true },
      gql: true,
      gqlQuery: null,
      endpointPath: "/api/search",
      auxFiles: [],
    });

    const references = [...source.matchAll(/\b([A-Z][A-Z0-9_]*_QUERY)\b/g)].map((m) => m[1]!);
    const declarations = [...source.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*_QUERY)\s*=/g)].map(
      (m) => m[1]!
    );
    const undeclaredReferences = references.filter((name) => !declarations.includes(name));
    expect(undeclaredReferences, source).toEqual([]);
    expect(source).not.toContain("createGraphqlClient");
    expect(source).toContain("createHttpClient");

    const siteDir = join(REPO_ROOT, "src", "sites", siteId);
    try {
      mkdirSync(join(siteDir, "flows"), { recursive: true });
      writeFileSync(join(siteDir, "contract.ts"), source);
      // contract.ts always imports its sibling browser-flow module — stub it
      // out with the same exported signature the real generator emits
      // (emitBrowserFlowTs, recon-generate.ts:13651) purely so tsc can
      // resolve the import; its body is irrelevant to this test.
      writeFileSync(
        join(siteDir, "flows", "browser-flow.ts"),
        `export async function runGqlEmissionDecisionFixtureBrowserFlow(
  stagehand: unknown,
  baseUrl: unknown,
  payload: unknown,
  sessionProxy: unknown
): Promise<unknown> {
  return undefined;
}
`
      );
      assertTypechecksClean("emit-direct", `${siteDir.slice(REPO_ROOT.length + 1)}/**/*.ts`);
    } finally {
      rmSync(siteDir, { recursive: true, force: true });
    }
  });
});

const REST_HOST = "www.gql-emission-decision-parity-noisy-rest-fixture.example.com";
const LIST_URL = `https://${REST_HOST}/catalog/search/`;
const SUBMIT_URL = `https://${REST_HOST}/catalog/submit/`;

function restCapture(overrides: {
  url: string;
  requestPostData: string | null;
  responseBody: unknown;
  timestamp: string;
  operationName?: string | null;
}): Capture {
  return {
    timestamp: overrides.timestamp,
    phase: "action",
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData,
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: overrides.operationName ?? null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function noisyRestCaptures(): Capture[] {
  return [
    restCapture({
      url: LIST_URL,
      requestPostData: JSON.stringify({ storeId: "STORE-DISTRIBUTION-CENTER-01" }),
      responseBody: { results: [{ itemId: "item-a" }] },
      timestamp: "2026-05-01T00:00:00Z",
      // No `query` document accompanies this — only a bare operation label,
      // the shape report item 4 traced through `isGraphQL()`'s gate.
      operationName: "catalogSearch",
    }),
    restCapture({
      url: SUBMIT_URL,
      requestPostData: JSON.stringify({
        itemId: "item-a",
        storeId: "STORE-DISTRIBUTION-CENTER-01",
      }),
      responseBody: { ok: true },
      timestamp: "2026-05-01T00:00:01Z",
    }),
  ];
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — report item 4 re-verified on current HEAD", () => {
  it("falls through to REST emission for a noisy archive shaped like the report, never referencing an undeclared _QUERY const", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-emission-decision-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, noisyRestCaptures());

    const siteId = `gql-emission-decision-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
          { step: "submit item selection", submitStep: true },
        ],
        submitEndpointPattern: "catalog/submit",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [REST_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toMatch(/\b[A-Z][A-Z0-9_]*_QUERY\b/);
    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).toContain("createHttpClient");

    assertTypechecksClean("cli-noisy-rest", `${siteOutDir.slice(REPO_ROOT.length + 1)}/**/*.ts`);
  }, 60_000);
});
