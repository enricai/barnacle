import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end proof for the reported defect: a capture selected as the
 * primary GraphQL operation whose own `operationName` field is null (sent
 * as an inline query document) must have its real name parsed from the
 * query body and its real variables wired into the emitted contract.ts,
 * instead of falling back to a fabricated `${pascal}Search` name and a
 * `{ q: payload.query }` variables expression.
 *
 * Mirrors recon-generate-gql-string-facet-e2e.test.ts's spawnSync-the-real-CLI
 * pattern.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — null operationName on the selected primary GraphQL capture", () => {
  it("emits the parsed query name and the real captured variables, not the fabricated placeholder", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-null-op-name-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // A second, unrelated capture with a real top-level operationName so
    // `isGraphQL` classifies the whole capture set as GraphQL — mirroring a
    // real recon run where some requests are named and some are sent as
    // inline query documents.
    const decoyCapture = {
      timestamp: "2026-08-19T19:15:00.000Z",
      phase: "search",
      method: "POST",
      url: "https://www.catalog-fixture.example.com/graphql",
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({ variables: {} }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { session: { id: "xyz" } },
      operationName: "SessionInit",
      query: "query SessionInit { session { id } }",
      variables: {},
      decodedParams: null,
    };
    writeFileSync(join(capturesDir, "000-search-action.json"), JSON.stringify(decoyCapture));

    // The reported shape: the capture's top-level `operationName` field is
    // null (inline query document), but the query body itself is named and
    // the variables are populated with a real filter. Its response is the
    // largest and its variables match the flow's Category field, so it wins
    // `selectPrimaryGraphQLOperation`'s scoring.
    const capture = {
      timestamp: "2026-08-19T19:16:15.000Z",
      phase: "search",
      method: "POST",
      url: "https://www.catalog-fixture.example.com/graphql",
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({
        variables: { filters: "visiting:CARI" },
      }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: {
        catalogItems: Array.from({ length: 50 }, (_, i) => ({ id: `catalog-${i}` })),
      },
      operationName: null,
      query:
        "query CatalogSearchResults($filters: String) { catalogItems(filters: $filters) { id } }",
      variables: { filters: "visiting:CARI" },
      decodedParams: null,
    };
    writeFileSync(join(capturesDir, "001-search-action.json"), JSON.stringify(capture));

    const siteId = `gql-null-op-name-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contractPath = join(siteOutDir, "contract.ts");
    expect(existsSync(contractPath)).toBe(true);
    const contract = readFileSync(contractPath, "utf8");

    expect(contract).toContain('getGql(context.baseUrl)("CatalogSearchResults"');
    expect(contract).not.toMatch(/Search"/);
    expect(contract).not.toContain("{ q: payload.query }");
  }, 60_000);

  it("emits the real endpoint, name and facet variables for a comment-prefixed operationName-null query composed with a third-party host and a same-endpoint sibling query", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-comment-prefixed-null-op-incident-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    const OWN_BACKEND_HOST = "www.own-backend-fixture.example.com";
    const THIRD_PARTY_HOST = "sdk.third-party-decoy.example.net";

    // A far more frequent non-GraphQL third-party host, never satisfying
    // isGraphQL() -- a decoy that must not win primary-operation selection.
    const thirdPartyBeacon = {
      timestamp: "2026-08-21T09:00:00.000Z",
      phase: "home",
      method: "GET",
      url: `https://${THIRD_PARTY_HOST}/collect/flags`,
      status: 200,
      requestHeaders: {},
      requestPostData: null,
      responseHeaders: {},
      responseBody: { flags: { enabled: true } },
      operationName: null,
      query: null,
      variables: null,
      decodedParams: null,
    };
    for (let i = 0; i < 10; i++) {
      writeFileSync(
        join(capturesDir, `000-home-decoy-${String(i).padStart(2, "0")}.json`),
        JSON.stringify(thirdPartyBeacon)
      );
    }

    // A same-endpoint, named, non-facet query -- must lose to the
    // facet-bearing search below despite outnumbering it.
    const siblingQuery = {
      timestamp: "2026-08-21T09:00:05.000Z",
      phase: "open-the-filter",
      method: "POST",
      url: `https://${OWN_BACKEND_HOST}/x/graph`,
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: "{}",
      responseHeaders: {},
      responseBody: { filterOptions: { categories: [{ id: "1", label: "one" }] } },
      operationName: "FilterOptionsMetadata",
      query: "query FilterOptionsMetadata { filterOptions { categories { id label } } }",
      variables: null,
      decodedParams: null,
    };
    for (let i = 0; i < 10; i++) {
      writeFileSync(
        join(capturesDir, `100-open-the-filter-sibling-${String(i).padStart(2, "0")}.json`),
        JSON.stringify(siblingQuery)
      );
    }

    // The real facet-bearing search: operationName-less, sent as an inline
    // query document that begins with a `#` comment line, on the own-backend
    // host/endpoint shared with the sibling query above.
    const facetQuery = {
      timestamp: "2026-08-21T09:00:10.000Z",
      phase: "open-the-filter",
      method: "POST",
      url: `https://${OWN_BACKEND_HOST}/x/graph`,
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({ variables: { metro: "AUSTIN" } }),
      responseHeaders: {},
      responseBody: {
        listings: Array.from({ length: 50 }, (_, i) => ({ id: `listing-${i}` })),
      },
      operationName: null,
      query:
        "# FilteredSearch\nquery FilteredSearch($metro: String) { listings(metro: $metro) { id name } }",
      variables: { metro: "AUSTIN" },
      decodedParams: null,
    };
    writeFileSync(
      join(capturesDir, "200-open-the-filter-facet-00.json"),
      JSON.stringify(facetQuery)
    );

    const siteId = `gql-comment-prefixed-null-op-incident-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "apply the metro filter", payloadField: "metro" }],
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

    expect(contract).toContain(`https://${OWN_BACKEND_HOST}`);
    expect(contract).toMatch(/endpoint: .*\/x\/graph/);
    expect(contract).toContain('getGql(context.baseUrl)("FilteredSearch"');
    expect(contract).toContain("listings(metro: $metro)");
    expect(contract).toMatch(/\{\s*metro:\s*payload\.metro\s*\}/);

    expect(contract).not.toContain(THIRD_PARTY_HOST);
    expect(contract).not.toContain("collect/flags");
    expect(contract).not.toContain("FilterOptionsMetadata");
    expect(contract).not.toContain("filterOptions");
  }, 60_000);
});
