import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { unreferencedDeclaredPayloadFields } from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.click-facet-case-only-array-fixture.example.com";

const FIVE_ELEMENTS = [
  "DEC26;filterType=date",
  "ALPHA;filterType=destination",
  "BRAVO;filterType=theme",
  "CHARLIE;filterType=ship",
  "DELTA;filterType=privateLodge",
];
const SIX_ELEMENTS = [...FIVE_ELEMENTS, "4;filterType=night"];

const DESTINATION_STEP =
  "Open the destination filter dropdown in the quote bar and select the 'Garden' destination option, keeping the other filters that are already applied";
const NIGHTS_STEP =
  "Open the stay length (number of nights) filter dropdown in the quote bar and select the '4' nights option, keeping the other filters that are already applied";

const NAVIGATE_STEPS = [
  {
    step: "navigate to the ship page",
    navigateTo: `https://${OWN_BACKEND_HOST}/#/ship/charlie`,
    payloadField: "ship",
  },
  {
    step: "navigate to the sailing month",
    navigateTo: `https://${OWN_BACKEND_HOST}/#/ship/charlie/dec-2026`,
    payloadField: "tripMonth",
  },
  {
    step: "navigate to the theme page",
    navigateTo: `https://${OWN_BACKEND_HOST}/#/theme/bravo`,
    payloadField: "theme",
  },
  {
    step: "navigate to the island page",
    navigateTo: `https://${OWN_BACKEND_HOST}/#/island/delta`,
    payloadField: "privateLodge",
  },
];
const CLICK_STEPS = [
  { step: DESTINATION_STEP, payloadField: "destination" },
  { step: NIGHTS_STEP, payloadField: "nights" },
];
const DECLARED_STEPS = [...NAVIGATE_STEPS, ...CLICK_STEPS].map((entry) => ({
  step: entry.step,
  payloadField: entry.payloadField,
}));

/**
 * Repro surface for click-step facets in a kind-suffixed array when the
 * quoted literal differs from the captured element only by case, the field
 * name ("nights") differs from the kind ("night"), and the date-like field
 * ("tripMonth") differs from its kind ("date").
 */
function buildCaptures(filters: string[]): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/browse/`,
      requestPostData: JSON.stringify({
        ids: [
          "charlie;filterId=urlFriendlyId",
          "dec-2026;filterId=urlFriendlyId",
          "bravo;filterId=urlFriendlyId",
          "delta;filterId=urlFriendlyId",
        ],
      }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/quote/`,
      requestPostData: JSON.stringify({ filters }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:01.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/submit/`,
      requestPostData: JSON.stringify({ confirm: true }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:02.000Z",
    }),
  ];
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function generate(filters: string[]): { contract: string; browserFlow: string; output: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-click-facet-case-only-"));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, buildCaptures(filters));

  const siteId = `click-facet-case-only-array-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [...NAVIGATE_STEPS, ...CLICK_STEPS, { step: "submit the quote", submitStep: true }],
      submitEndpointPattern: "submit",
      requireSubmitEndpointMatch: true,
      ownBackendHostnames: [OWN_BACKEND_HOST],
    })
  );

  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status, output).toBe(0);
  return {
    contract: readFileSync(join(siteOutDir, "contract.ts"), "utf8"),
    browserFlow: readFileSync(join(siteOutDir, "flows", "browser-flow.ts"), "utf8"),
    output,
  };
}

function facetElement(field: string, kind: string): RegExp {
  return new RegExp(`payload\\.${field}[^\\x60]*;filterType=${kind}`);
}

const FACETS: Array<[string, string]> = [
  ["destination", "destination"],
  ["nights", "night"],
  ["tripMonth", "date"],
  ["theme", "theme"],
  ["ship", "ship"],
  ["privateLodge", "privateLodge"],
];

describe("recon-generate CLI — case-only click facets in a kind-suffixed array", () => {
  it("reads every declared facet as payload.<field> in the six-element array", () => {
    const { contract, browserFlow } = generate(SIX_ELEMENTS);

    for (const [field, kind] of FACETS) {
      expect(contract, contract).toMatch(facetElement(field, kind));
    }
    for (const literal of SIX_ELEMENTS) {
      expect(contract, contract).not.toContain(literal);
    }
    expect(unreferencedDeclaredPayloadFields(contract, browserFlow, DECLARED_STEPS)).toEqual([]);
  }, 30_000);

  it("reads every present facet and warns for nights in the five-element array", () => {
    const { contract, browserFlow, output } = generate(FIVE_ELEMENTS);

    for (const [field, kind] of FACETS.filter(([field]) => field !== "nights")) {
      expect(contract, contract).toMatch(facetElement(field, kind));
    }
    expect(output).toContain("declared payloadField nights is read by no emitted request");
    expect(unreferencedDeclaredPayloadFields(contract, browserFlow, DECLARED_STEPS)).toEqual([]);
  }, 30_000);
});
