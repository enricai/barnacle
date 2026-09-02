import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end proof for the reported defect: a real `recon:generate` run over
 * a GraphQL capture whose facets live only inside a delimited `filters`
 * string, combined with a recon-flow.json declaring some of those facets'
 * fill steps as `optional: true`, must emit a contract.ts that (a)
 * conditionally joins the filters segments so an absent optional facet drops
 * its `key:value` segment instead of surfacing `key:undefined`, and (b)
 * marks the corresponding payload-schema fields `.optional()`.
 *
 * Mirrors recon-generate-gql-string-facet-e2e.test.ts's spawnSync-the-real-CLI
 * + throwaway-tsconfig + Biome-clean pattern verbatim.
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

/**
 * A minimal `--vocabulary` module resolving the three facet labels to
 * payloadFields, matching recon-generate-gql-string-facet-e2e.test.ts's own
 * vocabulary-module construction.
 */
function writeVocabularyModule(dir: string): string {
  const vocabPath = join(dir, "vocabulary.mjs");
  writeFileSync(
    vocabPath,
    `export const vocabulary = {
  subject: /(?!)/,
  exclusions: [],
  table: [
    [/region/i, "Region"],
    [/brand/i, "Brand"],
    [/len/i, "Len"],
  ],
};
`
  );
  return vocabPath;
}

describe("recon-generate CLI — GraphQL filters-string facet splice with optional payloadFields, end to end", () => {
  it("conditionally joins the filters segments and marks the optional facets' schema fields optional", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }
    if (!existsSync(BIOME_BIN)) {
      throw new Error(`biome binary not found at ${BIOME_BIN} — run pnpm install`);
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-facet-string-splice-optional-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // The reported grammar shape: three facets packed as `key:value` segments
    // inside the opaque `filters` string — one required (region), two
    // optional (brand, len).
    const capture = {
      timestamp: "2026-08-19T19:16:15.000Z",
      phase: "search",
      method: "POST",
      url: "https://www.catalog-fixture.example.com/graphql",
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({
        variables: {
          sort: { by: "RECOMMENDED" },
          filters: "region:R1|brand:B1|len:3~5",
        },
      }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { products: [{ id: "abc" }] },
      operationName: "catalogSearch_Products",
      query:
        "query catalogSearch_Products($sort: SortInput, $filters: String) { products(sort: $sort, filters: $filters) { id } }",
      variables: {
        sort: { by: "RECOMMENDED" },
        filters: "region:R1|brand:B1|len:3~5",
      },
      decodedParams: null,
    };
    writeFileSync(join(capturesDir, "000-search-action.json"), JSON.stringify(capture));

    const siteId = `facet-string-splice-optional-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });

    // One required step (region) and two optional steps (brand, len) — the
    // flow-step optional flag this codebase already threads for
    // submit/upload steps (recon-generate.ts:9087-9106).
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "Fill in the Region field with 'R1'" },
          { step: "Fill in the Brand field with 'B1'", optional: true },
          { step: "Fill in the Len field with '3~5'", optional: true },
        ],
      })
    );

    const vocabularyPath = writeVocabularyModule(workDir);

    const result = spawnSync(
      TSX_BIN,
      [
        GENERATE_SCRIPT,
        "--site-id",
        siteId,
        "--run-dir",
        runRoot,
        "--emit",
        "ts",
        "--force",
        "--vocabulary",
        vocabularyPath,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contractPath = join(siteOutDir, "contract.ts");
    expect(existsSync(contractPath)).toBe(true);
    const contract = readFileSync(contractPath, "utf8");

    // (a) the reported defect: an absent optional facet must never surface
    // as `key:undefined` anywhere in the generated call site.
    expect(contract).not.toContain("undefined");

    // (b) the filters segments are conditionally joined — the required facet
    // (region) always contributes, the optional facets (brand, len) are each
    // guarded on their payload value. Each unit carries its own trailing
    // delimiter, so the units are concatenated rather than joined on a
    // single recovered delimiter.
    expect(contract).toMatch(/\.join\(""\)/);
    expect(contract).toMatch(/payload\.Brand\s*\?/);
    expect(contract).toMatch(/payload\.Len\s*\?/);
    expect(contract).not.toMatch(/payload\.Region\s*\?/);

    // (c) the payload schema marks the optional facets `.optional()`.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    expect(schema).toMatch(/Brand:[^\n]*\.optional\(\)/);
    expect(schema).toMatch(/Len:[^\n]*\.optional\(\)/);
    expect(schema).not.toMatch(/Region:[^\n]*\.optional\(\)/);

    // (d) the emitted `payload` parameter is now referenced, so Biome's
    // noUnusedFunctionParameters warning must not fire on it — asserted with
    // the repo's own biome binary, not a structural substring check.
    const lint = execFileSync(BIOME_BIN, ["lint", "--config-path", REPO_ROOT, contractPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
    expect(lint).not.toMatch(/noUnusedFunctionParameters/);
    expect(lint).not.toMatch(/This parameter payload is unused/);

    // (e) the emitted contract.ts compiles cleanly, matching
    // recon-generate-gql-string-facet-e2e.test.ts's throwaway-tsconfig +
    // paths-override pattern verbatim.
    tsconfigPath = join(REPO_ROOT, `tsconfig.facet-string-splice-optional-e2e.${process.pid}.json`);
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
