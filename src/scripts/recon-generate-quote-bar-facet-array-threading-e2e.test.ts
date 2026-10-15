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

const OWN_BACKEND_HOST = "www.quote-bar-facet-array-threading-fixture.example.com";

const FIVE_ELEMENTS = [
  "2026-12;filterType=date",
  "BAHAMAS;filterType=destination",
  "MERRY;filterType=theme",
  "WW;filterType=ship",
  "EXTRA;filterType=venue",
];
const SIX_ELEMENTS = [...FIVE_ELEMENTS, "4;filterType=night"];

const DESTINATION_STEP =
  "Open the destination filter dropdown in the quote bar and select the 'Bahamas' destination option, keeping the other filters that are already applied";
const NIGHTS_STEP =
  "Open the length of stay (number of nights) filter dropdown in the search bar and select the '4' nights option, keeping the other filters that are already applied";

const DECLARED_STEPS = [
  { step: "navigate to the ship page", payloadField: "ship" },
  { step: "navigate to the ship's month", payloadField: "month" },
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
          "paris-trips;filterId=urlFriendlyId",
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
  workDir = mkdtempSync(join(tmpdir(), "barnacle-quote-bar-facet-array-"));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, buildCaptures(filters));

  const siteId = `quote-bar-facet-array-threading-test-${process.pid}`;
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
          payloadField: "month",
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

describe("recon-generate CLI — click and navigateTo facets threaded into a filterType array", () => {
  it("replaces the date, destination, ship and nights elements and keeps theme and venue literal", () => {
    const { contract, browserFlow } = generate(SIX_ELEMENTS);
    const filtersExpression = contract.slice(contract.indexOf("filters"));

    expect(filtersExpression).toContain("payload.destination");
    expect(filtersExpression).toContain("payload.nights");
    expect(filtersExpression).toContain("payload.month");
    expect(filtersExpression).toContain("payload.ship");
    expect(contract, contract).toMatch(/payload\.destination[^`]*;filterType=destination/);
    expect(contract, contract).toMatch(/payload\.nights[^`]*;filterType=night/);
    expect(contract, contract).toMatch(/payload\.month[^`]*;filterType=date/);
    expect(contract, contract).toMatch(/payload\.ship[^`]*;filterType=ship/);
    for (const gone of [
      "2026-12;filterType=date",
      "BAHAMAS;filterType=destination",
      "WW;filterType=ship",
      "4;filterType=night",
    ]) {
      expect(contract, contract).not.toContain(gone);
    }
    for (const literal of ["MERRY;filterType=theme", "EXTRA;filterType=venue"]) {
      expect(contract, contract).toContain(literal);
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
      ";filterType=venue",
      ";filterType=night",
    ].map((kind) => contract.indexOf(kind));

    expect(
      order.every((at) => at >= 0),
      contract
    ).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  }, 30_000);

  it("still threads the five-element variant and reports nights as unread", () => {
    const { contract, browserFlow, output } = generate(FIVE_ELEMENTS);

    expect(output).toContain("declared payloadField nights is read by no emitted request");
    expect(contract, contract).toMatch(/payload\.destination[^`]*;filterType=destination/);
    expect(contract, contract).toMatch(/payload\.month[^`]*;filterType=date/);
    expect(contract, contract).toMatch(/payload\.ship[^`]*;filterType=ship/);
    expect(unreferencedDeclaredPayloadFields(contract, browserFlow, DECLARED_STEPS)).toEqual([]);
  }, 30_000);
});
