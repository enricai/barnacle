import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Closes the GraphQL-variables sibling of the report's array-element
 * splice shape: a navigateTo-declared payloadField whose extracted hash
 * literal never appears standalone, but recurs — suffixed by a constant
 * delimiter string — as one element inside a captured GraphQL operation's
 * array-typed variable, must have `renderGqlVariablesExpr` splice
 * `payload.<field>` into that element's position for EVERY matched facet,
 * not just the first. Decomposed from
 * recon-generate-navigateto-array-element-facet-splice-e2e.test.ts's REST
 * body shape, mirroring recon-generate-gql-string-facet-e2e.test.ts's
 * real-CLI + tsc + biome verification scaffolding.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const BIOME_BIN = resolve(REPO_ROOT, "node_modules", ".bin", "biome");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.gql-navigateto-array-element-facet-splice-fixture.example.com";
const CATEGORY_TOKEN = "catx-gql-array-facet-hash-9931";
const BRAND_TOKEN = "brandx-gql-array-facet-hash-4420";
const DELIMITER = ";filterId=urlFriendlyId";

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

describe("recon-generate CLI — navigateTo facets threaded into a GraphQL array-valued variable, end to end", () => {
  it("splices payload.<field> for every navigateTo facet packed into a GraphQL array variable, emitting lint-clean and tsc-clean output", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }
    if (!existsSync(BIOME_BIN)) {
      throw new Error(`biome binary not found at ${BIOME_BIN} — run pnpm install`);
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-navigateto-array-element-facet-splice-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // Neither facet literal ever appears standalone as a top-level GraphQL
    // variable key — both live only as elements of the `filters` array,
    // each suffixed by the same constant delimiter string, mirroring the
    // report's exact recurrence shape but for the GraphQL variables grammar.
    const filtersArray = [
      `${CATEGORY_TOKEN}${DELIMITER}`,
      "evergreen-item",
      `${BRAND_TOKEN}${DELIMITER}`,
    ];
    const capture = {
      timestamp: "2026-08-19T19:16:15.000Z",
      phase: "search",
      method: "POST",
      url: `https://${OWN_BACKEND_HOST}/graphql`,
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({
        variables: { sort: { by: "RECOMMENDED" }, filters: filtersArray },
      }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { products: [{ id: "abc" }] },
      operationName: "catalogSearch_Products",
      query:
        "query catalogSearch_Products($sort: SortInput, $filters: [String!]) { products(sort: $sort, filters: $filters) { id } }",
      variables: { sort: { by: "RECOMMENDED" }, filters: filtersArray },
      decodedParams: null,
    };
    writeFileSync(join(capturesDir, "000-search-action.json"), JSON.stringify(capture));

    const siteId = `gql-navigateto-array-element-facet-splice-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });

    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the catalog with the category facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${CATEGORY_TOKEN}`,
            payloadField: "CategoryFacet",
          },
          {
            step: "navigate to the catalog with the brand facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${BRAND_TOKEN}`,
            payloadField: "BrandFacet",
          },
          { step: "browse catalog" },
        ],
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contractPath = join(siteOutDir, "contract.ts");
    expect(existsSync(contractPath)).toBe(true);
    const contract = readFileSync(contractPath, "utf8");

    // Both facets are threaded into the GraphQL variables expression, not
    // just the first one the array-element splice encounters.
    expect(contract).toContain("payload.CategoryFacet");
    expect(contract).toContain("payload.BrandFacet");
    expect(contract).toContain(`\`\${payload.CategoryFacet}${DELIMITER}\``);
    expect(contract).toContain(`\`\${payload.BrandFacet}${DELIMITER}\``);

    // Neither raw hash literal survives frozen inside a JSON.stringify'd
    // array — the splice must have rewritten both occurrences.
    expect(contract).not.toContain(CATEGORY_TOKEN);
    expect(contract).not.toContain(BRAND_TOKEN);

    // The emitted `payload` parameter is now referenced, so Biome's
    // noUnusedFunctionParameters warning must not fire on it.
    const lint = execFileSync(BIOME_BIN, ["lint", "--config-path", REPO_ROOT, contractPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
    expect(lint).not.toMatch(/noUnusedFunctionParameters/);
    expect(lint).not.toMatch(/This parameter payload is unused/);

    // The emitted contract.ts compiles cleanly, matching
    // recon-generate-tsc-clean-emit-e2e.test.ts's throwaway-tsconfig +
    // paths-override pattern.
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.gql-navigateto-array-facet-splice-e2e.${process.pid}.json`
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
    const referencesContract = diagnostics.includes("contract.ts");
    expect(referencesContract, diagnostics).toBe(false);
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
