import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Pins isGraphQL() (recon-generate.ts) against a same-domain, own-backend-
 * provenance minority host — unlike the third-party-noise sibling test
 * (recon-generate-thirdparty-graphql-noise-does-not-flip-rest-classification-e2e.test.ts),
 * BOTH hosts here are declared in ownBackendHostnames, mirroring a real
 * mid-session redirect target rather than an unrelated widget. The minority
 * host fires real, non-null operationName/query GraphQL captures — a thin
 * fraction against the primary host's overwhelming REST/JSON volume — and
 * must not flip the flow's classification away from REST.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PRIMARY_HOST = "www.catalog-rest-fixture.example.com";
const SECONDARY_OWN_BACKEND_HOST = "auth.catalog-rest-fixture.example.com";

function restCapture(overrides: {
  phase: string;
  method: string;
  url: string;
  status: number;
  responseBody: unknown;
}) {
  return {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: overrides.phase,
    method: overrides.method,
    url: overrides.url,
    status: overrides.status,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: null,
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function graphqlCapture(overrides: {
  phase: string;
  url: string;
  operationName: string;
  query: string;
  responseBody: unknown;
}) {
  return {
    timestamp: "2026-08-18T10:23:02.000Z",
    phase: overrides.phase,
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      operationName: overrides.operationName,
      query: overrides.query,
    }),
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: overrides.operationName,
    query: overrides.query,
    variables: null,
    decodedParams: null,
  };
}

/**
 * A run dir where the secondary host is ALSO declared own-backend
 * provenance (a legitimate mid-session redirect target, e.g. an auth
 * subdomain) and fires a single genuinely GraphQL-shaped capture, while the
 * primary own-backend host is overwhelmingly REST/JSON.
 */
function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  const ownBackendSearch = restCapture({
    phase: "search-catalog",
    method: "GET",
    url: `https://${PRIMARY_HOST}/api/catalog/search`,
    status: 200,
    responseBody: { items: [{ id: "1", name: "Widget A" }] },
  });
  for (let i = 0; i < 10; i++) {
    writeFileSync(
      join(root, "graphql", `000-search-catalog-action-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(ownBackendSearch)
    );
  }

  const secondaryHostGraphQL = graphqlCapture({
    phase: "home",
    url: `https://${SECONDARY_OWN_BACKEND_HOST}/graphql`,
    operationName: "SessionRefresh",
    query: "mutation SessionRefresh($token: String!) { sessionRefresh(token: $token) { ok } }",
    responseBody: { data: { sessionRefresh: { ok: true } } },
  });
  writeFileSync(
    join(root, "graphql", "100-home-noise.json"),
    JSON.stringify(secondaryHostGraphQL)
  );
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

describe("recon-generate CLI — own-backend-provenance minority GraphQL host must never flip a REST-majority flow's classification", () => {
  it("stays on the REST hot path and emits a tsc-clean contract with zero GraphQL scaffolding", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-ownbackend-minority-graphql-host-rest-classification-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `ownbackend-minority-graphql-host-rest-classification-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search catalog" }],
        ownBackendHostnames: [PRIMARY_HOST, SECONDARY_OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    expect(result.stdout).toContain(`generating plugin for ${siteId} (single-endpoint REST,`);
    expect(result.stdout).not.toContain("GraphQL");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The primary own-backend REST endpoint is reached via the plain HTTP client.
    expect(contract).toContain("createHttpClient");
    expect(contract).toContain("await httpClient(");
    expect(contract).toContain(`https://${PRIMARY_HOST}`);
    expect(contract).toContain("/api/catalog/search");

    // None of the GraphQL-only emission scaffolding is present.
    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).not.toContain("GqlFn");
    expect(contract).not.toContain("getGql");
    expect(contract).not.toMatch(/_QUERY\b/);

    // Zero occurrences of the minority host's operation.
    expect(contract).not.toContain("SessionRefresh");

    // Uniquely named and removed in afterEach so it never collides with the
    // real tsconfig, mirroring recon-generate-tsc-clean-emit-e2e.test.ts's
    // own throwaway-tsconfig pattern.
    tsconfigPath = join(REPO_ROOT, `tsconfig.recon-ownbackend-minority-graphql.${process.pid}.json`);
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
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
