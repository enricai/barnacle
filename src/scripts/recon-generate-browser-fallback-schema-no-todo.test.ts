import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { emitBrowserFlowTs, emitContractTs } from "@/scripts/recon-generate";

// G3 (docs/recon-generated-read-plugin-not-production-shaped.md): a
// non-submission browser fallback must validate against the SAME schema
// symbol emitContractTs exports as `${pascal}ResponseSchema` — not an
// independently-hand-authored placeholder — and its return path must carry
// no `as unknown as ${pascal}Response` cast, since z.infer of the shared
// schema already IS `${pascal}Response`.
describe("emitBrowserFlowTs — browser-fallback extract schema shares emitContractTs's ResponseSchema (G3)", () => {
  it("non-submission flow: imports and validates against the contract's ResponseSchema, no placeholder and no cast", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "some-site",
      pascal: "SomeSite",
      baseUrl: "https://example.com",
      flowSteps: [{ step: "Click search" }],
      isSubmissionFlow: false,
    });

    expect(code).toContain(
      'import { type SomeSitePayload, type SomeSiteResponse, SomeSiteResponseSchema } from "@/sites/some-site/contract";'
    );
    expect(code).not.toContain("SomeSiteBrowserSchema");
    expect(code).not.toContain("extraction: z.string()");
    expect(code).toContain("SomeSiteResponseSchema");
    expect(code).not.toMatch(/as unknown as SomeSiteResponse/);
    expect(code).toMatch(/return result;\s*\n}/);
  });

  it("submission flow: unaffected, still emits its own verified: z.boolean() schema", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "some-site",
      pascal: "SomeSite",
      baseUrl: "https://example.com",
      flowSteps: [{ step: "Click submit", submitStep: true }],
      isSubmissionFlow: true,
    });

    expect(code).toContain("verified: z.boolean()");
    expect(code).toContain("SomeSiteBrowserSchema");
  });

  it("emitContractTs exports the ResponseSchema by name, not only as default", () => {
    const contractCode = emitContractTs({
      siteId: "some-site",
      pascal: "SomeSite",
      baseUrl: "https://example.com",
      baseHeaders: {},
      minTime: 200,
      safeRps: 5,
      responseBody: { results: [{ id: "1" }] },
      gql: false,
      gqlQuery: null,
      endpointPath: "/search",
      auxFiles: [],
    });

    expect(contractCode).toContain("export const SomeSiteResponseSchema =");
  });
});

/**
 * Companion e2e compile check, mirroring
 * recon-generate-tsc-clean-emit-e2e.test.ts's spawnSync-the-real-CLI +
 * throwaway-tsconfig pattern: a real single-action (non-submission) GraphQL
 * capture generates a contract.ts + browser-flow.ts pair that must still
 * `tsc --noEmit` clean now that the placeholder extract schema and the cast
 * are both gone.
 */
const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
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

describe("recon-generate CLI — non-submission browser-fallback schema parity, end to end", () => {
  it("emits a contract.ts and browser-flow.ts sharing ResponseSchema that compile with zero diagnostics", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-browser-fallback-schema-parity-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    const capture = {
      timestamp: "2026-08-19T19:16:15.000Z",
      phase: "search",
      method: "POST",
      url: "https://www.catalog-fixture.example.com/graphql",
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({ variables: { sort: { by: "RECOMMENDED" } } }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { products: [{ id: "abc" }] },
      operationName: "catalogSearch_Products",
      query: "query catalogSearch_Products($sort: SortInput) { products(sort: $sort) { id } }",
      variables: { sort: { by: "RECOMMENDED" } },
      decodedParams: null,
    };
    writeFileSync(join(capturesDir, "000-search-action.json"), JSON.stringify(capture));

    const siteId = `browser-fallback-schema-parity-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });

    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ steps: [{ step: "Click search" }] })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contractPath = join(siteOutDir, "contract.ts");
    const browserFlowPath = join(siteOutDir, "flows", "browser-flow.ts");
    expect(existsSync(contractPath)).toBe(true);
    expect(existsSync(browserFlowPath)).toBe(true);

    const contract = readFileSync(contractPath, "utf8");
    const browserFlow = readFileSync(browserFlowPath, "utf8");
    const responseSchemaMatch = /export const (\w+ResponseSchema) =/.exec(contract);
    expect(responseSchemaMatch).not.toBeNull();
    const schemaSymbol = responseSchemaMatch![1]!;
    expect(browserFlow).toContain(schemaSymbol);
    expect(browserFlow).not.toMatch(/as unknown as \w+Response/);

    tsconfigPath = join(REPO_ROOT, `tsconfig.browser-fallback-schema-parity.${process.pid}.json`);
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
    const referencesEmittedFiles =
      diagnostics.includes("contract.ts") || diagnostics.includes("browser-flow.ts");
    expect(referencesEmittedFiles, diagnostics).toBe(false);
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
