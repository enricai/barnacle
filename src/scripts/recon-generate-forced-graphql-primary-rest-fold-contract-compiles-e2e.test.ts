import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Report item 4: a generated contract.ts referenced an undeclared
 * `${PASCAL}_QUERY`-shaped constant and failed `tsc`. Static reading of
 * `emitContractTs` found every declaration/reference site gated by the same
 * `isGqlEmission` boolean, so no independent defect could be pinned down from
 * source alone — this drives the real CLI over a genuinely mixed-backend
 * fixture (a real, correctly-classified GraphQL primary plus a REST-shaped
 * drill-down fold target, on a fictitious domain unrelated to any real site)
 * and pins zero-diagnostic `tsc -p` on the emitted contract.ts, mirroring
 * recon-generate-query-constant-declared-before-referenced-tsc-e2e.test.ts's
 * convention.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.forced-graphql-primary-rest-fold-fixture.example.com";
const SEARCH_QUERY =
  "query catalogSearch($filter: String) { catalogSearch(filter: $filter) { items { id title } } }";
const REPEAT_COUNT = 12;

function searchCapture(page: number, timestamp: string): unknown {
  const filter = `outdoor-${String(page).padStart(2, "0")}`;
  return {
    timestamp,
    phase: "browse",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: { filter } }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      catalogSearch: {
        items: [
          { id: `item-${filter}-1`, title: "Item 1" },
          { id: `item-${filter}-2`, title: "Item 2" },
        ],
      },
    },
    operationName: "catalogSearch",
    query: SEARCH_QUERY,
    variables: { filter },
    decodedParams: null,
  };
}

/** REST-shaped drill-down: no query/operationName, matches the declared foldReturn's endpointPattern. */
function drillCapture(itemId: string, timestamp: string): unknown {
  return {
    timestamp,
    phase: "browse",
    method: "GET",
    url: `https://${OWN_BACKEND_HOST}/catalog/api/v1/details?id=${itemId}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { detail: [{ id: itemId, region: "region-A" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  Array.from({ length: REPEAT_COUNT }, (_, i) =>
    searchCapture(i, `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`)
  ).forEach((capture, i) => {
    writeFileSync(
      join(root, "graphql", `${String(i).padStart(3, "0")}-browse-search.json`),
      JSON.stringify(capture)
    );
  });

  const firstFilter = `outdoor-${String(0).padStart(2, "0")}`;
  writeFileSync(
    join(root, "graphql", `${String(REPEAT_COUNT).padStart(3, "0")}-browse-drill.json`),
    JSON.stringify(
      drillCapture(
        `item-${firstFilter}-1`,
        `2024-01-01T00:00:${String(REPEAT_COUNT).padStart(2, "0")}Z`
      )
    )
  );
}

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [{ step: "search the catalog" }],
      ownBackendHostnames: [OWN_BACKEND_HOST],
      foldReturn: {
        endpointPattern: "/catalog/api/v1/details",
        resultsPath: "catalogSearch.items",
        drillResultsPath: "detail",
        joinFields: ["id"],
      },
    })
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

describe("recon-generate CLI — forced GraphQL-primary + REST-shaped drill-down fold contract compiles", () => {
  it("classifies GraphQL, resolves the fold, declares every referenced _QUERY const, and typechecks clean", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-forced-graphql-primary-rest-fold-contract-compiles-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `forced-graphql-primary-rest-fold-contract-compiles-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    writeFlowFile(siteOutDir);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combinedOutput).toBe(0);

    // The flow must have actually classified GraphQL and resolved the
    // declared fold — otherwise this fixture is not exercising the mixed
    // gql-primary/REST-fold shape the report described.
    expect(result.stdout).toContain(`generating plugin for ${siteId} (GraphQL,`);
    expect(combinedOutput).not.toContain("no fold plan resolved");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    expect(contract).toContain("getGql(context.baseUrl)(");
    expect(contract).toContain("createHttpClient");
    expect(contract).toContain("region");

    const references = extractQueryConstReferences(contract);
    const declarations = extractQueryConstDeclarations(contract);
    const undeclaredReferences = [...references].filter((name) => !declarations.has(name));
    expect(
      undeclaredReferences,
      JSON.stringify({ references: [...references], declarations: [...declarations] })
    ).toEqual([]);
    expect(references.size).toBeGreaterThan(0);

    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.forced-graphql-primary-rest-fold-contract-compiles.${process.pid}.json`
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
    const referencesEmittedFiles = diagnostics.includes("contract.ts");
    expect(referencesEmittedFiles, diagnostics).toBe(false);
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
