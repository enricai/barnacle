import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression coverage for "generated contract.ts referencing an undeclared
 * *_QUERY constant so output always compiles" (tag
 * query-const-declaration-regression-fix). recon-generate.ts documents a
 * single source of truth for every GraphQL-emission decision —
 * `isGqlEmission = gql && gqlQuery !== null` — reused identically at every
 * site that could reference a `${PASCAL}_QUERY` const: the single-call
 * fetch (recon-generate.ts:12707/13145), the paginated fetch loop
 * (recon-generate.ts:13140), and the required-URL-field guard's
 * self-healing narrowed-pool retry (`healUnreferencedUrlFieldsOnce`, which
 * re-runs the entire `generateFromCaptures` pipeline — including the same
 * `isGqlEmission` derivation — against a smaller capture pool). This test
 * drives the real CLI over three differently shaped fixtures covering each
 * of those paths and asserts, purely structurally, that every `_QUERY`-
 * shaped identifier referenced anywhere in the emitted source has a
 * matching `const ... _QUERY =` declaration in the same file, then pins
 * `tsc --noEmit` clean on the emitted output.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

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

function runGenerate(siteId: string, runRoot: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

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

function assertEveryReferenceDeclared(contract: string): void {
  const references = extractQueryConstReferences(contract);
  const declarations = extractQueryConstDeclarations(contract);
  const undeclared = [...references].filter((name) => !declarations.has(name));
  expect(
    undeclared,
    JSON.stringify({ references: [...references], declarations: [...declarations] })
  ).toEqual([]);
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

function assertTypechecksClean(siteId: string, siteOutDir: string): void {
  const tsconfigPath = join(
    REPO_ROOT,
    `tsconfig.query-const-declaration-regression.${siteId}.json`
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
  expect(diagnostics.includes("TS2304")).toBe(false);
  expect(check.status, diagnostics).toBe(0);
}

describe("generated contract.ts never references an undeclared *_QUERY const", () => {
  it("single-call GraphQL query emission declares and references the same const", () => {
    const workDir = mkdtempSync(join(tmpdir(), "barnacle-query-const-single-"));
    workDirs.push(workDir);
    const runRoot = join(workDir, "run");

    const query = "query productLookup($sku: String) { productLookup(sku: $sku) { id title } }";
    const capture: Capture = {
      timestamp: "2026-05-01T00:00:00Z",
      phase: "action",
      method: "POST",
      url: "https://www.query-const-regression-single.example.com/graph",
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({ query, variables: { sku: "SKU-1" } }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { productLookup: { id: "SKU-1", title: "Widget" } },
      operationName: "productLookup",
      query,
      variables: { sku: "SKU-1" },
      decodedParams: null,
    };
    writeRunDir(runRoot, [capture]);

    const siteId = `query-const-regression-single-e2e-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    siteOutDirs.push(siteOutDir);

    const result = runGenerate(siteId, runRoot);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    // Not a vacuous pass: the GraphQL emission path was actually taken.
    expect(contract).toContain("createGraphqlClient");
    expect(contract).toMatch(/\b[A-Z][A-Z0-9_]*_QUERY\b/);

    assertEveryReferenceDeclared(contract);
    assertTypechecksClean(siteId, siteOutDir);
  }, 60_000);

  it("paginated GraphQL fetch-loop emission declares and references the same const", () => {
    const workDir = mkdtempSync(join(tmpdir(), "barnacle-query-const-paginated-"));
    workDirs.push(workDir);
    const runRoot = join(workDir, "run");

    const query =
      "query listingSearch($pagination: PaginationInput) { listingSearch(pagination: $pagination) { total items { id title } } }";
    const makePage = (count: number, offset: number): Record<string, unknown>[] =>
      Array.from({ length: count }, (_, i) => ({
        id: `listing-${offset + i}`,
        title: `Listing ${offset + i}`,
      }));
    const capture: Capture = {
      timestamp: "2026-05-01T00:00:00Z",
      phase: "action",
      method: "POST",
      url: "https://www.query-const-regression-paginated.example.com/graph",
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({ query, variables: { pagination: { count: 2, skip: 0 } } }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { listingSearch: { total: 4, items: makePage(2, 1) } },
      operationName: "listingSearch",
      query,
      variables: { pagination: { count: 2, skip: 0 } },
      decodedParams: null,
    };
    writeRunDir(runRoot, [capture]);

    const siteId = `query-const-regression-paginated-e2e-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    siteOutDirs.push(siteOutDir);

    const result = runGenerate(siteId, runRoot);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    // Confirms the paginated fetch loop (not the single-call branch) was emitted.
    expect(contract).toContain("itemsById");
    expect(contract).toContain("MAX_PAGES");
    expect(contract).toContain("createGraphqlClient");
    expect(contract).toMatch(/\b[A-Z][A-Z0-9_]*_QUERY\b/);

    assertEveryReferenceDeclared(contract);
    assertTypechecksClean(siteId, siteOutDir);
  }, 60_000);

  it("invariant survives the required-URL-field guard's self-healing narrowed-pool retry", () => {
    // The self-heal only runs for flows that actually trip
    // assertRequiredUrlFieldsReferenced (a same-host, unthreaded noise
    // capture whose response carries a required *Url field). This REST
    // multi-step submission fixture is the smallest real trigger for that
    // retry in this codebase (mirrors
    // recon-generate-noise-capture-url-field-guard-self-heal.test.ts).
    // healUnreferencedUrlFieldsOnce re-runs the ENTIRE generateFromCaptures
    // pipeline — including the same isGqlEmission derivation the single-call
    // and paginated-loop tests above pin — against a narrowed capture pool,
    // so the invariant must hold on its output too, not just on a
    // first-pass-clean generation.
    const workDir = mkdtempSync(join(tmpdir(), "barnacle-query-const-selfheal-"));
    workDirs.push(workDir);
    const runRoot = join(workDir, "run");

    function noiseCapture(): Capture {
      return {
        timestamp: "2024-01-01T00:00:00.500Z",
        phase: "home",
        method: "POST",
        url: "https://api.example.com/site-banner",
        status: 200,
        requestHeaders: { "Content-Type": "application/json" },
        requestPostData: '{"pageId":"home"}',
        responseHeaders: { "content-type": "application/json" },
        responseBody: {
          webBannerImageUrl: "https://cdn.example.com/banner.png",
          mobileWebBannerImageUrl: "https://cdn.example.com/banner-mobile.png",
        },
        operationName: null,
        query: null,
        variables: null,
        decodedParams: null,
      };
    }

    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    const allCaptures = [actionCaptures[0]!, noiseCapture(), ...actionCaptures.slice(1)];
    writeRunDir(runRoot, allCaptures);

    const siteId = `query-const-regression-selfheal-e2e-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    siteOutDirs.push(siteOutDir);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "fill out applicant, address, contact, employment, and attachment sections" },
          { step: "submit address section", submitStep: true },
        ],
      })
    );

    const result = runGenerate(siteId, runRoot);
    const out = `${result.stdout}\n${result.stderr}`;
    expect(result.status, out).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain("webBannerImageUrl");

    assertEveryReferenceDeclared(contract);
    assertTypechecksClean(siteId, siteOutDir);
  }, 60_000);
});
