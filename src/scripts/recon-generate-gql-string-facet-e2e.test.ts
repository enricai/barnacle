import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end proof for the reported defect: a real `recon:generate` run over a
 * GraphQL capture whose payloadField facets live only inside a delimited
 * `filters` string (not as top-level variable keys) must emit an
 * `executeHttp` that actually threads `payload.<field>` into that string for
 * EVERY correlated facet — not just the first — and the resulting contract.ts
 * must be both Biome-clean (no `noUnusedFunctionParameters` warning on the
 * now-used `payload` param) and `tsc --noEmit`-clean.
 *
 * Mirrors recon-generate-tsc-clean-emit-e2e.test.ts's spawnSync-the-real-CLI +
 * throwaway-tsconfig pattern and recon-generate-biome-clean.test.ts's
 * execFileSync(BIOME_BIN, ["lint", ...]) pattern.
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
 * A minimal `--vocabulary` module resolving the two facet labels to
 * payloadFields, matching recon-generate-tsc-clean-emit-e2e.test.ts's own
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
    [/category/i, "Category"],
    [/format/i, "Format"],
  ],
};
`
  );
  return vocabPath;
}

describe("recon-generate CLI — GraphQL filters-string facet correlation, end to end", () => {
  it("splices payload.<field> for every facet packed into a filters string, emitting lint-clean and tsc-clean output", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }
    if (!existsSync(BIOME_BIN)) {
      throw new Error(`biome binary not found at ${BIOME_BIN} — run pnpm install`);
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-string-facet-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // The reported grammar shape: neither `category` nor `format` is a
    // top-level GraphQL variable key — both live as `key:value` segments
    // packed inside the opaque `filters` string.
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
          filters: "category:Fiction|format:Hardcover",
        },
      }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { products: [{ id: "abc" }] },
      operationName: "catalogSearch_Products",
      query:
        "query catalogSearch_Products($sort: SortInput, $filters: String) { products(sort: $sort, filters: $filters) { id } }",
      variables: {
        sort: { by: "RECOMMENDED" },
        filters: "category:Fiction|format:Hardcover",
      },
      decodedParams: null,
    };
    writeFileSync(join(capturesDir, "000-search-action.json"), JSON.stringify(capture));

    const siteId = `gql-string-facet-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });

    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "Fill in the Category field with 'Fiction'" },
          { step: "Fill in the Format field with 'Hardcover'" },
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

    // (a) both facets are threaded into the executeHttp body, not just the
    // first one the string-splice correlation encounters.
    expect(contract).toContain("payload.Category");
    expect(contract).toContain("payload.Format");
    expect(contract).toContain(
      "filters: `category:$" + "{payload.Category}|format:$" + "{payload.Format}`"
    );

    // (b) the emitted `payload` parameter is now referenced, so Biome's
    // noUnusedFunctionParameters warning must not fire on it — asserted with
    // the repo's own biome binary, not a structural substring check.
    const lint = execFileSync(BIOME_BIN, ["lint", "--config-path", REPO_ROOT, contractPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
    expect(lint).not.toMatch(/noUnusedFunctionParameters/);
    expect(lint).not.toMatch(/This parameter payload is unused/);

    // (c) the emitted contract.ts compiles cleanly, matching
    // recon-generate-tsc-clean-emit-e2e.test.ts's throwaway-tsconfig +
    // paths-override pattern verbatim.
    tsconfigPath = join(REPO_ROOT, `tsconfig.gql-string-facet-e2e.${process.pid}.json`);
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
