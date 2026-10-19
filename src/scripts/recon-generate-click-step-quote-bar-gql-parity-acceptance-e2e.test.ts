import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";

/**
 * GraphQL counterpart of the REST quote-bar filterType acceptance test: the
 * same click-step facets delivered as a `filters` GraphQL variable must be
 * threaded through the variables expression so both transports agree.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.gql-click-step-quote-bar-parity-fixture.example.com";

const ELEMENTS = [
  "2026-12;filterType=release",
  "SH;filterType=category",
  "WP;filterType=feature",
  "4;filterType=night",
  "LT;filterType=weight",
  "EU;filterType=market",
];

const FLOW_STEPS = [
  {
    step: "Open the category filter dropdown in the quote bar and select the 'Shoes' category option, keeping the other filters that are already applied",
    payloadField: "destination",
  },
  {
    step: "Open the nights filter dropdown in the quote bar and select the '4' nights option, keeping the other filters that are already applied",
    payloadField: "nights",
  },
  { step: "browse products" },
];

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function generate(): { contract: string; output: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-quote-bar-parity-"));
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

  const variables = { filters: ELEMENTS };
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
      responseBody: { products: [{ id: "p-1001" }] },
      operationName: "quoteSearch",
      query: "query quoteSearch($filters: [String!]) { products(filters: $filters) { id } }",
      variables,
      decodedParams: null,
    })
  );

  const siteId = `gql-click-step-quote-bar-parity-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({ steps: FLOW_STEPS, ownBackendHostnames: [OWN_BACKEND_HOST] })
  );

  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status, output).toBe(0);
  return { contract: readFileSync(join(siteOutDir, "contract.ts"), "utf8"), output };
}

describe("recon-generate CLI — GraphQL quote-bar click-step facets in a kind-suffixed array", () => {
  it("splices destination and nights into their filterType elements in captured order", () => {
    const { contract, output } = generate();

    expect(contract, contract).toMatch(/payload\.destination[^\x60]*;filterType=category/);
    expect(contract, contract).toMatch(/payload\.nights[^\x60]*;filterType=night/);
    expect(contract).not.toContain("SH;filterType=category");
    expect(contract).not.toContain("4;filterType=night");
    expect(output).not.toMatch(/read by no emitted request/);

    const order = ELEMENTS.map((e) => contract.indexOf(`;filterType=${e.split("=")[1]}`));
    expect(
      order.every((at) => at >= 0),
      contract
    ).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  }, 60_000);
});
