import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";

/**
 * A GraphQL `filters` variable of `<CODE>;filterType=<kind>` elements must
 * thread click-declared and hash-declared facets into the element of their own
 * kind, exactly as the REST body pass does for the same vocabulary.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.gql-kind-suffixed-array-facet-parity-fixture.example.com";

const FILTERS = ["GARDEN;filterType=destination", "2026-12;filterType=date", "4;filterType=night"];

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function generate(): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-kind-suffixed-array-parity-"));
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

  const variables = { sort: "RELEVANCE", filters: FILTERS };
  writeFileSync(
    join(capturesDir, "000-search-action.json"),
    JSON.stringify({
      timestamp: "2026-08-19T19:16:15.000Z",
      phase: "search",
      method: "POST",
      url: `https://${OWN_BACKEND_HOST}/graphql`,
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({ variables }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { trips: [{ id: "abc" }] },
      operationName: "tripSearch",
      query:
        "query tripSearch($sort: String, $filters: [String!]) { trips(sort: $sort, filters: $filters) { id } }",
      variables,
      decodedParams: null,
    })
  );

  const siteId = `gql-kind-suffixed-array-facet-parity-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        {
          step: "navigate to the month",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/trips/december-2026`,
          payloadField: "month",
        },
        { step: "click the 'Garden' option", payloadField: "destination", optional: true },
        { step: "click the '4' option", payloadField: "nights", optional: true },
        { step: "browse trips" },
      ],
      ownBackendHostnames: [OWN_BACKEND_HOST],
    })
  );

  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

describe("recon-generate CLI — GraphQL kind-suffixed array facet parity with REST", () => {
  it("makes every declared facet's element payload-driven with no hardcoded literal", () => {
    const contract = generate();

    expect(contract, contract).toMatch(/payload\.destination[^`]*;filterType=destination/);
    expect(contract, contract).toMatch(/payload\.month[^`]*;filterType=date/);
    expect(contract, contract).toMatch(/payload\.nights[^`]*;filterType=night/);
    expect(contract).not.toContain('"GARDEN;filterType=destination"');
    expect(contract).not.toContain("2026-12;filterType=date");
    expect(contract).not.toContain('"4;filterType=night"');
  }, 30_000);
});
