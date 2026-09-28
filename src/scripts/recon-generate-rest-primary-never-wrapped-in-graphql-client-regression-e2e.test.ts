import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end proof that when the winning primary operation is a genuine
 * REST/JSON endpoint, emitContractTs never emits the GraphQL client
 * synthesis scaffolding (clientImport's createGraphqlClient import,
 * gqlCacheBlock's GqlFn type / getGql() / gqlCache) around it — even when
 * the recon archive also contains real GraphQL-shaped noise from a
 * third-party host. clientImport and gqlCacheBlock (recon-generate.ts) are
 * both gated on the same `gql` boolean from isGraphQL(); an own-backend
 * REST archive must never take that branch regardless of unrelated
 * third-party GraphQL traffic recorded alongside it.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-catalog.example.com";
const THIRD_PARTY_HOST = "chat.third-party-gql-widget.example.net";

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
 * A run dir with real GraphQL POST captures on a distinct third-party host
 * (populated operationName/query) outnumbering a plain REST GET capture on
 * the own-backend host, matching a chat widget or analytics SDK making real
 * GraphQL calls alongside a REST backend.
 */
function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  const thirdPartyGraphQL = graphqlCapture({
    phase: "home",
    url: `https://${THIRD_PARTY_HOST}/graphql`,
    operationName: "TrackWidgetEvent",
    query: "mutation TrackWidgetEvent($event: String!) { trackEvent(event: $event) { ok } }",
    responseBody: { data: { trackEvent: { ok: true } } },
  });
  for (let i = 0; i < 5; i++) {
    writeFileSync(
      join(root, "graphql", `000-home-widget-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(thirdPartyGraphQL)
    );
  }

  const ownBackendSearch = restCapture({
    phase: "search-catalog",
    method: "GET",
    url: `https://${OWN_BACKEND_HOST}/api/catalog/search`,
    status: 200,
    responseBody: { items: [{ id: "1", name: "Item A" }] },
  });
  writeFileSync(
    join(root, "graphql", "100-search-catalog-action.json"),
    JSON.stringify(ownBackendSearch)
  );
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — REST primary operation is never wrapped in GraphQL client scaffolding", () => {
  it("emits createHttpClient/httpClient and never GqlFn/getGql/createGraphqlClient", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-rest-never-gql-client-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `rest-never-gql-client-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search catalog" }],
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The REST client-construction path is emitted.
    expect(contract).toContain("createHttpClient");
    expect(contract).toContain("await httpClient(");

    // None of the GraphQL client synthesis scaffolding — gated on the same
    // `gql` boolean as the createHttpClient-only clientImport branch — leaks
    // into a REST-primary contract, even with third-party GraphQL noise
    // present in the archive.
    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).not.toContain("type GqlFn");
    expect(contract).not.toContain("function getGql");
    expect(contract).not.toContain("gqlCache");
  }, 30_000);
});
