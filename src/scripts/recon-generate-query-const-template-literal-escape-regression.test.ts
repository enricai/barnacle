import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { emitContractTs } from "@/scripts/recon-generate";

/**
 * Proves the queryConst escaping fix actually prevents the reported
 * `Cannot find name '<SITE>_QUERY'` class of compile failure: any GraphQL
 * query text containing a literal backtick or a `${...}` sequence must
 * still produce a QUERY declaration that is syntactically closed (not
 * terminated early by an unescaped backtick) and compiles as real
 * TypeScript, expressed generically with no real site/plugin name.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const BASE = "https://api.example.com";

const outDirs: string[] = [];
const tsconfigPaths: string[] = [];

afterEach(() => {
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
  for (const file of tsconfigPaths) rmSync(file, { force: true });
  outDirs.length = 0;
  tsconfigPaths.length = 0;
});

function assertQueryConstCompilesSafely(source: string, siteId: string, pascal: string): void {
  const declarationPattern = new RegExp(
    `const\\s+${pascal.toUpperCase()}_QUERY\\s*=\\s*\`[\\s\\S]*?\`;`
  );
  const declarationMatch = source.match(declarationPattern);
  expect(declarationMatch, source).not.toBeNull();

  const constName = `${pascal.toUpperCase()}_QUERY`;
  const queryReferenceLine = source
    .split("\n")
    .find((line) => line.includes(`(${constName},`) || line.includes(`, ${constName},`));
  expect(queryReferenceLine, source).toBeDefined();
  expect(queryReferenceLine).toContain(constName);

  const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  outDirs.push(siteOutDir);
  mkdirSync(join(siteOutDir, "flows"), { recursive: true });
  writeFileSync(join(siteOutDir, "contract.ts"), source);
  writeFileSync(
    join(siteOutDir, "flows", "browser-flow.ts"),
    `export async function run${pascal}BrowserFlow(
  stagehand: unknown,
  baseUrl: unknown,
  payload: unknown,
  sessionProxy: unknown
): Promise<unknown> {
  return undefined;
}
`
  );

  if (!existsSync(TSC_BIN)) {
    throw new Error("tsc not installed — cannot verify the emitted source compiles");
  }
  const tsconfigPath = join(
    REPO_ROOT,
    `tsconfig.query-const-template-literal-escape.${siteId}.${process.pid}.json`
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
  expect(check.status, diagnostics).toBe(0);
}

describe("emitContractTs queryConst — compiles safely for backtick/${} GraphQL query text", () => {
  it("emits a syntactically closed QUERY const when the query text contains a literal backtick", () => {
    const siteId = `query-const-escape-backtick-test${process.pid}`;
    const pascal = "QueryConstEscapeBacktickFixture";
    const source = emitContractTs({
      siteId,
      pascal,
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { id: "abc", active: true },
      endpointPath: "/graphql",
      gql: true,
      gqlQuery: "query { field(label: `weird`) }",
      auxFiles: [],
    });

    assertQueryConstCompilesSafely(source, siteId, pascal);
  }, 60_000);

  it("emits a syntactically closed QUERY const when the query text contains a ${...} splice-like sequence", () => {
    const siteId = `query-const-escape-splice-test${process.pid}`;
    const pascal = "QueryConstEscapeSpliceFixture";
    const source = emitContractTs({
      siteId,
      pascal,
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { id: "abc", active: true },
      endpointPath: "/graphql",
      gql: true,
      gqlQuery: "query { field(id: ${maliciousSplice}) }",
      auxFiles: [],
    });

    assertQueryConstCompilesSafely(source, siteId, pascal);
  }, 60_000);
});
