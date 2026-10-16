import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";

/**
 * The GraphQL twin of the REST six-element `;filterType=<kind>` repro: click
 * and navigateTo facets must each own their element of the `filters` variable,
 * with order preserved and no element left literal.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.gql-kind-suffixed-six-element-parity-fixture.example.com";

const FILTERS = [
  "2026-12;filterType=date",
  "BAHAMAS;filterType=destination",
  "MERRY;filterType=theme",
  "WW;filterType=ship",
  "GOC;filterType=hiddenCove",
  "4;filterType=night",
];

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function generate(): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-six-element-parity-"));
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

  const variables = { filters: FILTERS };
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
      query: "query tripSearch($filters: [String!]) { trips(filters: $filters) { id } }",
      variables,
      decodedParams: null,
    })
  );

  const siteId = `gql-kind-suffixed-six-element-parity-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        {
          step: "navigate to the month",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/trips/december-2026`,
          payloadField: "tripMonth",
        },
        { step: "click the 'Bahamas' option", payloadField: "destination" },
        {
          step: "navigate to the theme page",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/theme/merry`,
          payloadField: "theme",
        },
        {
          step: "navigate to the ship page",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/ship/ww`,
          payloadField: "ship",
        },
        {
          step: "navigate to the island page",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/island/goc`,
          payloadField: "hiddenCove",
        },
        { step: "click the '4' option", payloadField: "nights" },
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

describe("recon-generate CLI — GraphQL six-element kind-suffixed array parity with REST", () => {
  it("threads every declared facet into its own element with order preserved", () => {
    const contract = generate();

    const facets: Array<[string, string]> = [
      ["tripMonth", "date"],
      ["destination", "destination"],
      ["theme", "theme"],
      ["ship", "ship"],
      ["hiddenCove", "hiddenCove"],
      ["nights", "night"],
    ];
    for (const [field, kind] of facets) {
      expect(contract, contract).toMatch(
        new RegExp(`payload\\.${field}[^\\x60]*;filterType=${kind}`)
      );
    }
    for (const literal of FILTERS) expect(contract).not.toContain(literal);

    const order = facets.map(([, kind]) => contract.indexOf(`;filterType=${kind}`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  }, 30_000);
});
