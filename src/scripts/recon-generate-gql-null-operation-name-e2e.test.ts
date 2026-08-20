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
      url: "https://www.cruise-fixture.example.com/graphql",
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
      url: "https://www.cruise-fixture.example.com/graphql",
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({
        variables: { filters: "visiting:CARI" },
      }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: {
        cruises: Array.from({ length: 50 }, (_, i) => ({ id: `cruise-${i}` })),
      },
      operationName: null,
      query: "query CruisesSearchResults($filters: String) { cruises(filters: $filters) { id } }",
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

    expect(contract).toContain('getGql(context.baseUrl)("CruisesSearchResults"');
    expect(contract).not.toMatch(/Search"/);
    expect(contract).not.toContain("{ q: payload.query }");
  }, 60_000);
});
