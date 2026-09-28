import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Generalizes the item-4 report (a REST flow misclassified as GraphQL,
 * whose emitted contract.ts referenced an undeclared `${PASCAL}_QUERY`
 * const and failed to compile) into a corpus-agnostic structural
 * invariant: every `<PASCAL>_QUERY`-shaped identifier referenced anywhere
 * in an emitted contract.ts must have a matching `const ... _QUERY =`
 * declaration in the same file. Drives the real CLI over two differently
 * shaped fixtures — a genuine GraphQL flow and a noisy REST flow shaped
 * like the report — extracting both reference and declaration sets purely
 * via regex, then separately pins zero-diagnostic `tsc -p` on each emitted
 * site.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function gqlCapture(overrides: {
  url: string;
  operationName: string | null;
  query: string | null;
  variables: Record<string, unknown> | null;
  responseBody: unknown;
  timestamp: string;
  requestPostData?: string;
}): Capture {
  return {
    timestamp: overrides.timestamp,
    phase: "action",
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData ?? "{}",
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: overrides.operationName,
    query: overrides.query,
    variables: overrides.variables,
    decodedParams: null,
  };
}

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

const GRAPHQL_HOST = "www.query-constant-parity-graphql-fixture.example.com";
const GRAPHQL_URL = `https://${GRAPHQL_HOST}/graph`;

/** A genuine GraphQL read flow: a named query with a real document body. */
function genuineGraphQLCaptures(): Capture[] {
  return [
    gqlCapture({
      url: GRAPHQL_URL,
      operationName: "catalogSearch_Items",
      query: "query catalogSearch_Items($region: String) { items(region: $region) { id name } }",
      variables: { region: "WEST" },
      responseBody: { items: [{ id: "item-a", name: "Item A" }] },
      timestamp: "2026-05-01T00:00:00Z",
      requestPostData: '{"region":"WEST"}',
    }),
  ];
}

// A noisy REST archive shaped like the reported incident: one own-backend
// capture carries a non-null `operationName` (as third-party GraphQL
// telemetry sometimes does), which alone flips `isGraphQL()` true, but NO
// capture on the flow carries a real `query` document — so query-text
// resolution comes up empty and generation must fall through to REST
// emission rather than referencing an undeclared `_QUERY` const.
const REST_HOST = "www.query-constant-parity-noisy-rest-fixture.example.com";
const LIST_URL = `https://${REST_HOST}/catalog/search/`;
const SUBMIT_URL = `https://${REST_HOST}/catalog/submit/`;

function noisyRestCaptures(): Capture[] {
  return [
    restCapture({
      url: LIST_URL,
      requestPostData: JSON.stringify({ storeId: "STORE-DISTRIBUTION-CENTER-01" }),
      responseBody: { results: [{ itemId: "item-a" }] },
      timestamp: "2026-05-01T00:00:00Z",
      // No `query` document accompanies this — only a bare operation label,
      // exactly the shape that previously slipped past isGraphQL()'s gate
      // without ever resolving a real query string.
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

let workDirs: string[] = [];
let siteOutDirs: string[] = [];
let tsconfigPaths: string[] = [];

afterEach(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
  for (const dir of siteOutDirs) rmSync(dir, { recursive: true, force: true });
  for (const path of tsconfigPaths) rmSync(path, { force: true });
  workDirs = [];
  siteOutDirs = [];
  tsconfigPaths = [];
});

/** Every `<PASCAL>_QUERY`-shaped identifier referenced anywhere in the emitted source. */
function extractQueryConstReferences(contract: string): Set<string> {
  const references = new Set<string>();
  for (const match of contract.matchAll(/\b([A-Z][A-Z0-9_]*_QUERY)\b/g)) {
    references.add(match[1]!);
  }
  return references;
}

/** Every `<PASCAL>_QUERY`-shaped identifier declared with `const ... =` in the emitted source. */
function extractQueryConstDeclarations(contract: string): Set<string> {
  const declarations = new Set<string>();
  for (const match of contract.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*_QUERY)\s*=/g)) {
    declarations.add(match[1]!);
  }
  return declarations;
}

function generateAndAssertQueryConstParity(
  siteId: string,
  runRoot: string
): { contract: string; siteOutDir: string } {
  const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  siteOutDirs.push(siteOutDir);

  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );

  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

  const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

  const references = extractQueryConstReferences(contract);
  const declarations = extractQueryConstDeclarations(contract);

  const undeclaredReferences = [...references].filter((name) => !declarations.has(name));
  expect(
    undeclaredReferences,
    JSON.stringify({ references: [...references], declarations: [...declarations] })
  ).toEqual([]);

  return { contract, siteOutDir };
}

function assertTypechecksClean(siteId: string, siteOutDir: string): void {
  if (!existsSync(TSC_BIN)) {
    throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
  }

  const tsconfigPath = join(
    REPO_ROOT,
    `tsconfig.query-constant-declared-before-referenced.${siteId}.json`
  );
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
      include: [`${siteOutDir.slice(REPO_ROOT.length + 1)}/**/*.ts`],
    })
  );

  const check = spawnSync(TSC_BIN, ["-p", tsconfigPath, "--noEmit"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  const diagnostics = `${check.stdout}\n${check.stderr}`;
  const referencesEmittedFiles = diagnostics.includes("contract.ts");
  expect(referencesEmittedFiles, diagnostics).toBe(false);
  expect(check.status, diagnostics).toBe(0);
}

describe("recon-generate CLI + tsc --noEmit — every referenced _QUERY const is declared", () => {
  it("declares GENUINEGRAPHQLFIXTURE_QUERY for a real GraphQL flow and typechecks clean", () => {
    const workDir = mkdtempSync(join(tmpdir(), "barnacle-query-const-parity-graphql-"));
    workDirs.push(workDir);
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, genuineGraphQLCaptures());

    const siteId = `query-const-parity-graphql-e2e-test${process.pid}`;
    const { contract, siteOutDir } = generateAndAssertQueryConstParity(siteId, runRoot);

    // Genuine GraphQL emission actually took the QUERY-const path, so this
    // fixture isn't a vacuous zero-reference pass.
    expect(contract).toMatch(/\b[A-Z][A-Z0-9_]*_QUERY\b/);
    expect(contract).toContain("createGraphqlClient");

    assertTypechecksClean(siteId, siteOutDir);
  }, 60_000);

  it("never references an undeclared _QUERY const for a noisy REST archive shaped like the misclassification report, and typechecks clean", () => {
    const workDir = mkdtempSync(join(tmpdir(), "barnacle-query-const-parity-rest-"));
    workDirs.push(workDir);
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, noisyRestCaptures());

    const siteId = `query-const-parity-rest-e2e-test${process.pid}`;
    siteOutDirs.push(join(REPO_ROOT, "src", "sites", siteId));
    mkdirSync(join(REPO_ROOT, "src", "sites", siteId), { recursive: true });
    writeFileSync(
      join(REPO_ROOT, "src", "sites", siteId, "recon-flow.json"),
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

    const { contract, siteOutDir } = generateAndAssertQueryConstParity(siteId, runRoot);

    // The report's actual regression: generation must fall through to REST
    // emission, never referencing a _QUERY const that has no query text to
    // declare it from.
    expect(contract).not.toMatch(/\b[A-Z][A-Z0-9_]*_QUERY\b/);
    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).toContain("createHttpClient");

    assertTypechecksClean(siteId, siteOutDir);
  }, 60_000);
});
