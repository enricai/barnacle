import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Pins isGraphQL() (recon-generate.ts) against the registrable-domain
 * FALLBACK branch of isAllowedFixtureHost, not the declared-multi-host
 * branch its sibling test
 * (recon-generate-ownbackend-minority-graphql-host-does-not-flip-rest-classification-e2e.test.ts)
 * covers. Here the flow declares NO `ownBackendHostnames` at all, so
 * `readOwnBackendHostnames` returns `[]`, `deriveBaseUrl` falls back to the
 * majority non-noise host, and `fallbackDomain` becomes that host's
 * registrable domain (recon-generate.ts's `generateFromCaptures`). The
 * minority host is an UNDECLARED subdomain sharing that registrable domain —
 * it clears the registrable-domain membership check in isAllowedFixtureHost,
 * but must still be rejected by that function's separate `primaryHost`
 * equality check, so its real GraphQL-shaped capture must never flip the
 * flow's classification away from REST.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PRIMARY_HOST = "www.orders-rest-fixture.example.net";
const UNDECLARED_SUBDOMAIN_HOST = "auth.orders-rest-fixture.example.net";

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
 * A run dir where NO own-backend hosts are declared, so the primary host is
 * derived purely from capture majority and `fallbackDomain` from its
 * registrable domain. The minority host is an undeclared subdomain of that
 * same registrable domain — it passes the registrable-domain membership
 * check but must still be rejected by the `primaryHost` equality check.
 */
function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  const ownBackendSearch = restCapture({
    phase: "search-orders",
    method: "GET",
    url: `https://${PRIMARY_HOST}/api/orders/search`,
    status: 200,
    responseBody: { items: [{ id: "1", name: "Order A" }] },
  });
  for (let i = 0; i < 10; i++) {
    writeFileSync(
      join(root, "graphql", `000-search-orders-action-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(ownBackendSearch)
    );
  }

  const subdomainGraphQL = graphqlCapture({
    phase: "home",
    url: `https://${UNDECLARED_SUBDOMAIN_HOST}/graphql`,
    operationName: "SessionRefresh",
    query: "mutation SessionRefresh($token: String!) { sessionRefresh(token: $token) { ok } }",
    responseBody: { data: { sessionRefresh: { ok: true } } },
  });
  writeFileSync(join(root, "graphql", "100-home-noise.json"), JSON.stringify(subdomainGraphQL));
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

describe("recon-generate CLI — undeclared same-registrable-domain subdomain GraphQL noise must never flip a REST-majority flow's classification", () => {
  it("stays on the REST hot path and emits a tsc-clean contract with zero GraphQL scaffolding", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-fallback-domain-minority-graphql-subdomain-rest-classification-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `fallback-domain-minority-graphql-subdomain-rest-classification-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    // Deliberately NO `ownBackendHostnames` field — readOwnBackendHostnames
    // returns [] for this shape, which is exactly what activates the
    // registrable-domain fallback branch in isAllowedFixtureHost, as opposed
    // to the declared-multi-host exact-match branch the sibling test covers.
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search orders" }],
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
    expect(contract).toContain("/api/orders/search");

    // None of the GraphQL-only emission scaffolding is present.
    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).not.toContain("GqlFn");
    expect(contract).not.toContain("getGql");
    expect(contract).not.toMatch(/_QUERY\b/);

    // Zero occurrences of the undeclared subdomain's operation.
    expect(contract).not.toContain("SessionRefresh");

    // Uniquely named and removed in afterEach so it never collides with the
    // real tsconfig, mirroring recon-generate-tsc-clean-emit-e2e.test.ts's
    // own throwaway-tsconfig pattern.
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.recon-fallback-domain-minority-graphql.${process.pid}.json`
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
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
