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

const OWN_BACKEND_HOST = "www.click-facet-filtertype-vocabulary-fixture.example.com";

const FIVE_ELEMENTS = [
  "2026-12;filterType=date",
  "BAHAMAS;filterType=destination",
  "MERRY;filterType=theme",
  "WW;filterType=ship",
  "GOC;filterType=privateIsland",
];
const SIX_ELEMENTS = [...FIVE_ELEMENTS, "4;filterType=night"];

const DESTINATION_STEP =
  "Open the destination filter dropdown in the quote bar and select the 'Bahamas' destination option, keeping the other filters that are already applied";
const NIGHTS_STEP =
  "Open the length of stay (number of nights) filter dropdown in the search bar and select the '4' nights option, keeping the other filters that are already applied";

const DECLARED_STEPS = [
  { step: "navigate to the ship page", payloadField: "ship" },
  { step: "navigate to the ship's month", payloadField: "sailMonth" },
  { step: "navigate to the theme page", payloadField: "theme" },
  { step: "navigate to the private island page", payloadField: "privateIsland" },
  { step: DESTINATION_STEP, payloadField: "destination" },
  { step: NIGHTS_STEP, payloadField: "nights" },
];

/**
 * Proves, through the real `recon:generate` CLI, that click-step facets
 * (destination, nights) and navigateTo hash facets (a date-like month and a
 * ship-like facet whose slugs recur only in a `;filterId=urlFriendlyId` body)
 * each replace their own element of a `;filterType=<kind>` filters array.
 */
function buildCaptures(filters: string[]): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/browse/`,
      requestPostData: JSON.stringify({
        ids: [
          "west-hub;filterId=urlFriendlyId",
          "december-2026;filterId=urlFriendlyId",
          "festive-season;filterId=urlFriendlyId",
          "palm-cay;filterId=urlFriendlyId",
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
  workDir = mkdtempSync(join(tmpdir(), "barnacle-click-facet-filtertype-"));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, buildCaptures(filters));

  const siteId = `click-facet-filtertype-vocabulary-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        {
          step: "navigate to the ship page",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/ship/west-hub`,
          payloadField: "ship",
        },
        {
          step: "navigate to the ship's month",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/ship/west-hub/december-2026`,
          payloadField: "sailMonth",
        },
        {
          step: "navigate to the theme page",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/theme/festive-season`,
          payloadField: "theme",
        },
        {
          step: "navigate to the private island page",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/island/palm-cay`,
          payloadField: "privateIsland",
        },
        { step: DESTINATION_STEP, payloadField: "destination" },
        { step: NIGHTS_STEP, payloadField: "nights" },
        { step: "submit the quote", submitStep: true },
      ],
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
  return new RegExp("payload\\." + field + "[^\\x60]*;filterType=" + kind);
}

/**
 * Diagnosis repro for the fix subtasks. On HEAD all three cases pass: the
 * report's arrays thread correctly when the filterId slugs in the fixture
 * recur in the navigateTo hashes, so a remaining failure needs a vocabulary
 * the fixture does not yet model.
 */
describe("recon-generate CLI — click and navigateTo facets in a kind-suffixed filters array", () => {
  it("threads every declared facet into its own element and keeps no literal", () => {
    const { contract, browserFlow } = generate(SIX_ELEMENTS);

    const facets: Array<[string, string]> = [
      ["destination", "destination"],
      ["nights", "night"],
      ["sailMonth", "date"],
      ["theme", "theme"],
      ["ship", "ship"],
      ["privateIsland", "privateIsland"],
    ];
    for (const [field, kind] of facets) {
      expect(contract, contract).toMatch(facetElement(field, kind));
    }
    for (const gone of [
      "2026-12;filterType=date",
      "BAHAMAS;filterType=destination",
      "MERRY;filterType=theme",
      "WW;filterType=ship",
      "GOC;filterType=privateIsland",
      "4;filterType=night",
    ]) {
      expect(contract, contract).not.toContain(gone);
    }
    expect(unreferencedDeclaredPayloadFields(contract, browserFlow, DECLARED_STEPS)).toEqual([]);
  }, 30_000);

  it("preserves the captured element order", () => {
    const { contract } = generate(SIX_ELEMENTS);
    const order = [
      ";filterType=date",
      ";filterType=destination",
      ";filterType=theme",
      ";filterType=ship",
      ";filterType=privateIsland",
      ";filterType=night",
    ].map((kind) => contract.indexOf(kind));

    expect(
      order.every((at) => at >= 0),
      contract
    ).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  }, 30_000);

  it("threads the five-element variant without a nights element", () => {
    const { contract, browserFlow, output } = generate(FIVE_ELEMENTS);

    expect(output).toContain("declared payloadField nights is read by no emitted request");

    const facets: Array<[string, string]> = [
      ["destination", "destination"],
      ["sailMonth", "date"],
      ["theme", "theme"],
      ["ship", "ship"],
      ["privateIsland", "privateIsland"],
    ];
    for (const [field, kind] of facets) {
      expect(contract, contract).toMatch(facetElement(field, kind));
    }
    expect(unreferencedDeclaredPayloadFields(contract, browserFlow, DECLARED_STEPS)).toEqual([]);
  }, 30_000);
});
