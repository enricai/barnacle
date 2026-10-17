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

const OWN_BACKEND_HOST = "www.mixed-vocabulary-click-facet-fixture.example.com";
const SEASON_SLUG = "summer-2026";
const PASS_SLUG = "festival-pass";
const VENUE_CODE = "MAIN-STAGE";
const REGION_CODE = "EUROPE";

const ELEMENTS = [
  "2026-12;filterType=date",
  `${REGION_CODE};filterType=region`,
  "CONCERT;filterType=category",
  "3;filterType=night",
  `${VENUE_CODE};filterType=venue`,
  "VIP;filterType=perk",
];

const REGION_STEP =
  "Open the region filter dropdown in the search bar and select the 'Europe' region option, keeping the other filters that are already applied";
const VENUE_STEP =
  "Open the venue filter dropdown in the search bar and select the 'Main-Stage' venue option, keeping the other filters that are already applied";

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
  { step: REGION_STEP, payloadField: "region" },
  { step: VENUE_STEP, payloadField: "venue" },
  { step: "submit the search", submitStep: true },
];

/**
 * Acceptance surface for the campaign contract that every declared
 * payloadField changes the emitted requests, whichever step kind declares it
 * and whichever vocabulary (slug or code) the request array uses.
 */
function fixtureCaptures(): Capture[] {
  const bodies: Array<[string, unknown, unknown]> = [
    [
      "/events/search/",
      {
        filters: ELEMENTS,
        tags: [`${SEASON_SLUG};filterId=slug`, `${PASS_SLUG};filterId=slug`],
      },
      { results: [{ eventId: "evt-1001" }] },
    ],
    ["/events/availability/evt-1001", { eventId: "evt-1001" }, { seats: [{ seatId: "s-1" }] }],
    ["/events/availability/", { confirm: true }, { ok: true }],
  ];
  return bodies.map(([path, body, responseBody], index) =>
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}${path}`,
      requestPostData: JSON.stringify(body),
      responseBody,
      timestamp: `2026-01-01T00:00:0${index}.000Z`,
    })
  );
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

describe("recon-generate CLI — mixed slug/code vocabularies with click-step facets and a foldReturn", () => {
  it("reads every declared payloadField and splices the kind-suffixed array", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-mixed-vocabulary-click-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `mixed-vocabulary-click-facet-test-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: FLOW_STEPS,
        submitEndpointPattern: "events/availability/$",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
        foldReturn: {
          endpointPattern: "events/availability",
          resultsPath: "results",
          drillResultsPath: "seats",
          joinFields: ["eventId"],
        },
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
    );
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const browserFlow = readFileSync(join(siteOutDir, "flows", "browser-flow.ts"), "utf8");

    for (const field of FLOW_STEPS.flatMap((s) => (s.payloadField ? [s.payloadField] : []))) {
      expect(contract, `${field}: ${contract}`).toContain(`payload.${field}`);
    }
    expect(
      unreferencedDeclaredPayloadFields(
        contract,
        browserFlow,
        FLOW_STEPS.filter((s) => s.payloadField).map((s) => ({
          step: s.step,
          payloadField: s.payloadField as string,
        }))
      ),
      output
    ).toEqual([]);

    expect(contract, contract).toMatch(/payload\.region[^\x60]*;filterType=region/);
    expect(contract, contract).not.toContain(`${REGION_CODE};filterType=region`);

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
