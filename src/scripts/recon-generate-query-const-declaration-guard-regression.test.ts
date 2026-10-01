import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

/**
 * Pins the general invariant behind the reported `DISNEYCRUISE_QUERY`
 * failure as a site-agnostic contract on `emitContractTs` itself, independent
 * of any one archive shape: whenever `gql` is true but no concrete GraphQL
 * query text was ever resolved (`gqlQuery === null`), `isGqlEmission` must be
 * false everywhere the emitted source decides whether to reference a
 * `PASCAL_QUERY` identifier — so the output never names a `const` it never
 * declares, regardless of which emission branch (plain single-call,
 * paginated-fetch-loop) classification routes through.
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

function assertNoUndeclaredQueryConstAndCompiles(
  source: string,
  siteId: string,
  pascal: string
): void {
  const references = [...source.matchAll(/\b([A-Z][A-Z0-9_]*_QUERY)\b/g)].map((m) => m[1]!);
  const declarations = [...source.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*_QUERY)\s*=/g)].map(
    (m) => m[1]!
  );
  const undeclaredReferences = references.filter((name) => !declarations.includes(name));
  expect(undeclaredReferences, source).toEqual([]);

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
    `tsconfig.query-const-declaration-guard.${siteId}.${process.pid}.json`
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

describe("emitContractTs — gql=true/gqlQuery=null never emits an undeclared *_QUERY reference", () => {
  it("plain single-call emission path (no fold plan, no pagination) declares no _QUERY const and references none", () => {
    const siteId = `query-const-guard-single-call-test${process.pid}`;
    const source = emitContractTs({
      siteId,
      pascal: "QueryConstGuardSingleCallFixture",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { items: [{ id: "a" }] },
      gql: true,
      gqlQuery: null,
      endpointPath: "/graphql",
      gqlOperationName: "search",
      gqlVariables: {},
      auxFiles: [],
    });

    expect(source).toContain("createHttpClient");
    expect(source).not.toContain("createGraphqlClient");
    assertNoUndeclaredQueryConstAndCompiles(source, siteId, "QueryConstGuardSingleCallFixture");
  }, 60_000);

  it("paginated-fetch-loop emission path under gql=true/gqlQuery=null declares no _QUERY const and references none", () => {
    const siteId = `query-const-guard-paginated-test${process.pid}`;
    const source = emitContractTs({
      siteId,
      pascal: "QueryConstGuardPaginatedFixture",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: {
        items: [{ id: "a" }],
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      },
      gql: true,
      gqlQuery: null,
      endpointPath: "/graphql",
      gqlOperationName: "search",
      gqlVariables: { after: null },
      auxFiles: [],
      allCaptures: [
        {
          timestamp: "2026-01-01T00:00:00Z",
          phase: "browse",
          method: "POST",
          url: `${BASE}/graphql`,
          status: 200,
          requestHeaders: { "Content-Type": "application/json" },
          requestPostData: JSON.stringify({ operationName: "search", variables: { after: null } }),
          responseHeaders: {},
          responseBody: {
            items: [{ id: "a" }],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
          operationName: "search",
          query: null,
          variables: { after: null },
          decodedParams: null,
        },
        {
          timestamp: "2026-01-01T00:00:01Z",
          phase: "browse",
          method: "POST",
          url: `${BASE}/graphql`,
          status: 200,
          requestHeaders: { "Content-Type": "application/json" },
          requestPostData: JSON.stringify({
            operationName: "search",
            variables: { after: "cursor-1" },
          }),
          responseHeaders: {},
          responseBody: {
            items: [{ id: "b" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          operationName: "search",
          query: null,
          variables: { after: "cursor-1" },
          decodedParams: null,
        },
      ],
    });

    assertNoUndeclaredQueryConstAndCompiles(source, siteId, "QueryConstGuardPaginatedFixture");
  }, 60_000);
});
