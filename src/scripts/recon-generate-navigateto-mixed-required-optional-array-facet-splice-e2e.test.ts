import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression guard for the multi-facet × optionality interaction surface:
 * recon-generate-navigateto-cumulative-array-element-facet-splice-e2e.test.ts
 * proves cumulative matching splices every facet (not just the first) into a
 * shared array field, and
 * recon-generate-navigateto-array-element-optional-facet-splice-e2e.test.ts
 * proves a single optional facet conditions its own element — but neither
 * exercises three facets, two required and one optional, packed into the
 * SAME array together. That combination is exactly the seam where a future
 * regression (optionality branching reintroducing wholesale
 * `JSON.stringify(payload.<arrayField>)` freezing, or the optional branch
 * swallowing its required siblings) would hide. Mirrors both source tests'
 * real-CLI + tsc + biome scaffolding, over a generic catalog/e-commerce
 * domain fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const BIOME_BIN = resolve(REPO_ROOT, "node_modules", ".bin", "biome");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

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

describe("recon-generate CLI — three navigateTo facets (two required, one optional) sharing one REST array field", () => {
  it("splices both required facets unconditionally and conditions the optional facet, without refreezing the array", () => {
    const OWN_BACKEND_HOST = "www.navigateto-mixed-array-facet-splice-fixture.example.com";
    const CATEGORY_TOKEN = "catx-mixed-array-facet-hash-3301";
    const BRAND_TOKEN = "brandx-mixed-array-facet-hash-5512";
    const SIZE_TOKEN = "sizex-mixed-array-facet-hash-7723";
    const DELIMITER = ";src=facet";

    function fixtureCaptures(): Capture[] {
      return [
        buildCapture({
          url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
          requestPostData: JSON.stringify({ sort: "relevance" }),
          responseBody: { ok: true },
          timestamp: "2026-05-01T00:00:00.000Z",
        }),
        buildCapture({
          url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/`,
          requestPostData: JSON.stringify({
            sort: "relevance",
            tags: [
              "in-stock",
              `${CATEGORY_TOKEN}${DELIMITER}`,
              `${BRAND_TOKEN}${DELIMITER}`,
              `${SIZE_TOKEN}${DELIMITER}`,
              "free-shipping",
            ],
          }),
          responseBody: { ok: true },
          timestamp: "2026-05-01T00:00:01.000Z",
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

    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-mixed-array-facet-splice-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `navigateto-mixed-array-facet-splice-test-${process.pid}`;
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
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${CATEGORY_TOKEN}/${BRAND_TOKEN}`,
            payloadField: "BrandFacet",
          },
          {
            step: "navigate to the catalog with the size facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${CATEGORY_TOKEN}/${SIZE_TOKEN}`,
            payloadField: "SizeFacet",
            optional: true,
          },
          { step: "browse catalog" },
          { step: "apply filters", submitStep: true },
        ],
        submitEndpointPattern: "catalog/filter-results",
        requireSubmitEndpointMatch: true,
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
    const contract = readFileSync(contractPath, "utf8");

    // The array field must never be refrozen wholesale — the exact pre-fix
    // #515/#516 regression this test guards against.
    expect(contract).not.toContain("JSON.stringify(payload.tags)");

    // No raw facet hash literal survives frozen anywhere in the output.
    expect(contract).not.toContain(CATEGORY_TOKEN);
    expect(contract).not.toContain(BRAND_TOKEN);
    expect(contract).not.toContain(SIZE_TOKEN);

    // An omitted optional facet must never splice the literal string
    // "undefined" into the body.
    expect(contract).not.toContain("undefined");

    // Both required facets still splice unconditionally — non-regression
    // against the cumulative multi-facet fix.
    expect(contract).toContain(`\`\${payload.CategoryFacet}${DELIMITER}\``);
    expect(contract).toContain(`\`\${payload.BrandFacet}${DELIMITER}\``);
    expect(contract).not.toContain("...(payload.CategoryFacet ?");
    expect(contract).not.toContain("...(payload.BrandFacet ?");

    // The optional sibling's element is conditioned on payload.SizeFacet via
    // a spread ternary, not inlined unconditionally like its required
    // siblings.
    expect(contract).toContain(
      `...(payload.SizeFacet ? [\`\${payload.SizeFacet}${DELIMITER}\`] : [])`
    );

    // The payload schema still declares all three facet fields.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    expect(schema).toMatch(/ {2}CategoryFacet: z\.string\(\),/);
    expect(schema).toMatch(/ {2}BrandFacet: z\.string\(\),/);
  }, 30_000);
});

describe("recon-generate CLI — three navigateTo facets (two required, one optional) sharing one GraphQL array variable", () => {
  it("splices both required facets unconditionally and conditions the optional facet, without refreezing the array", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }
    if (!existsSync(BIOME_BIN)) {
      throw new Error(`biome binary not found at ${BIOME_BIN} — run pnpm install`);
    }

    const OWN_BACKEND_HOST = "www.gql-navigateto-mixed-array-facet-splice-fixture.example.com";
    const CATEGORY_TOKEN = "catx-gql-mixed-array-facet-hash-1104";
    const BRAND_TOKEN = "brandx-gql-mixed-array-facet-hash-2215";
    const SIZE_TOKEN = "sizex-gql-mixed-array-facet-hash-3326";
    const DELIMITER = ";filterId=urlFriendlyId";

    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-navigateto-mixed-array-facet-splice-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // All three facet literals are elements of the captured `filters`
    // array, so each matches structurally; only the size facet's navigateTo
    // step declares `optional: true`.
    const filtersArray = [
      `${CATEGORY_TOKEN}${DELIMITER}`,
      "evergreen-item",
      `${BRAND_TOKEN}${DELIMITER}`,
      `${SIZE_TOKEN}${DELIMITER}`,
    ];
    const capture = {
      timestamp: "2026-08-20T19:16:15.000Z",
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

    const siteId = `gql-navigateto-mixed-array-facet-splice-test-${process.pid}`;
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
          {
            step: "navigate to the catalog with the size facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${SIZE_TOKEN}`,
            payloadField: "SizeFacet",
            optional: true,
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

    // The array variable must never be refrozen wholesale.
    expect(contract).not.toContain("JSON.stringify(payload.filters)");

    // No raw facet hash literal survives frozen anywhere in the output.
    expect(contract).not.toContain(CATEGORY_TOKEN);
    expect(contract).not.toContain(BRAND_TOKEN);
    expect(contract).not.toContain(SIZE_TOKEN);

    // The literal string "undefined" never appears in the spliced array
    // position.
    expect(contract).not.toContain("undefined");

    // Both required sibling facets still splice unconditionally.
    expect(contract).toContain(`\`\${payload.CategoryFacet}${DELIMITER}\``);
    expect(contract).toContain(`\`\${payload.BrandFacet}${DELIMITER}\``);
    expect(contract).not.toContain("...(payload.CategoryFacet ?");
    expect(contract).not.toContain("...(payload.BrandFacet ?");

    // The optional facet's array-element emission is structurally
    // conditioned on payload.SizeFacet via a spread ternary.
    expect(contract).toContain(
      `...(payload.SizeFacet ? [\`\${payload.SizeFacet}${DELIMITER}\`] : [])`
    );

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
      `tsconfig.gql-navigateto-mixed-array-facet-splice-e2e.${process.pid}.json`
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
