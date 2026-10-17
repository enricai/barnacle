import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";

/**
 * GraphQL counterpart of the REST mixed-vocabulary click-step test: a
 * `filters` variable of `<CODE>;filterType=<kind>` elements plus a slug-array
 * `tags` variable must bind every declared payloadField through the GraphQL
 * variables splice, so the campaign contract holds on either transport.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.gql-mixed-vocabulary-click-facet-fixture.example.com";
const SEASON_SLUG = "summer-2026";
const PASS_SLUG = "festival-pass";

const ELEMENTS = [
  "2026-12;filterType=date",
  "EUROPE;filterType=region",
  "CONCERT;filterType=category",
  "3;filterType=night",
  "MAIN-STAGE;filterType=venue",
  "VIP;filterType=perk",
];

const FLOW_STEPS = [
  {
    step: "navigate to the events page with the season applied",
    navigateTo: `https://${OWN_BACKEND_HOST}/#/events/season/${SEASON_SLUG}`,
    payloadField: "SeasonFacet",
  },
  {
    step: "navigate to the events page with the pass applied",
    navigateTo: `https://${OWN_BACKEND_HOST}/#/events/season/${SEASON_SLUG}/pass/${PASS_SLUG}`,
    payloadField: "PassFacet",
    optional: true,
  },
  {
    step: "Open the region filter dropdown in the search bar and select the 'Europe' region option, keeping the other filters that are already applied",
    payloadField: "region",
  },
  {
    step: "Open the venue filter dropdown in the search bar and select the 'Main-Stage' venue option, keeping the other filters that are already applied",
    payloadField: "venue",
  },
  { step: "browse events" },
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
  workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-mixed-vocabulary-click-"));
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

  const variables = {
    filters: ELEMENTS,
    tags: [`${SEASON_SLUG};filterId=slug`, `${PASS_SLUG};filterId=slug`],
  };
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
      responseBody: { events: [{ id: "evt-1001" }] },
      operationName: "eventSearch",
      query:
        "query eventSearch($filters: [String!], $tags: [String!]) { events(filters: $filters, tags: $tags) { id } }",
      variables,
      decodedParams: null,
    })
  );

  const siteId = `gql-mixed-vocabulary-click-facet-test-${process.pid}`;
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

describe("recon-generate CLI — GraphQL mixed slug/code vocabularies with click-step facets", () => {
  it("reads every declared payloadField and splices the kind-suffixed array in captured order", () => {
    const { contract } = generate();

    for (const field of FLOW_STEPS.flatMap((s) => ("payloadField" in s ? [s.payloadField] : []))) {
      expect(contract, `${field}: ${contract}`).toContain(`payload.${field}`);
    }

    expect(contract, contract).toMatch(/payload\.region[^`]*;filterType=region/);
    expect(contract, contract).toMatch(/payload\.venue[^`]*;filterType=venue/);
    expect(contract).not.toContain("EUROPE;filterType=region");
    expect(contract).not.toContain("MAIN-STAGE;filterType=venue");

    const order = [
      ";filterType=date",
      ";filterType=region",
      ";filterType=category",
      ";filterType=night",
      ";filterType=venue",
      ";filterType=perk",
    ].map((kind) => contract.indexOf(kind));
    expect(
      order.every((at) => at >= 0),
      contract
    ).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  }, 60_000);
});
