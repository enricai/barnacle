import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.click-step-five-element-array-threading-fixture.example.com";

const FIVE_ELEMENTS = [
  "2026-12;filterType=stay",
  "BAHAMAS;filterType=region",
  "MERRY;filterType=theme",
  "WW;filterType=carrier",
  "EXTRA;filterType=venue",
];

const REGION_STEP =
  "Open the region filter dropdown in the search bar and select the 'Bahamas' region option, keeping the other filters that are already applied";

/**
 * Proves, through the real `recon:generate` CLI, that a region facet declared
 * on a click step (no navigateTo hash) is threaded into its own
 * `;filterType=region` element, while the stay-month, theme, carrier and venue
 * facets come from a navigateTo hash carrying several comma-joined facets.
 */
function buildCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/browse/`,
      requestPostData: JSON.stringify({
        ids: [
          "west-hub;filterId=urlFriendlyId",
          "december-2026;filterId=urlFriendlyId",
          "paris-trips;filterId=urlFriendlyId",
          "north-pier;filterId=urlFriendlyId",
        ],
      }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/quote/`,
      requestPostData: JSON.stringify({ filters: FIVE_ELEMENTS }),
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

function generate(): { contract: string; output: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-click-step-five-element-"));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, buildCaptures());

  const siteId = `click-step-five-element-array-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        {
          step: "navigate with the stay month, theme, carrier and venue applied",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/lodging/december-2026,paris-trips,west-hub,north-pier`,
          payloadField: "stayMonth",
        },
        {
          step: "navigate to the theme page",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/lodging/paris-trips`,
          payloadField: "theme",
        },
        {
          step: "navigate to the carrier page",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/lodging/west-hub`,
          payloadField: "carrier",
        },
        {
          step: "navigate to the venue page",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/lodging/north-pier`,
          payloadField: "venue",
        },
        { step: REGION_STEP, payloadField: "region" },
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
  return { contract: readFileSync(join(siteOutDir, "contract.ts"), "utf8"), output };
}

describe("recon-generate CLI — click-step facet threaded into a five-element filterType array", () => {
  it("threads the click-step region into its own element and leaves no declared facet literal", () => {
    const { contract } = generate();

    expect(contract, contract).toMatch(/payload\.region[^`]*;filterType=region/);
    expect(contract, contract).toMatch(/payload\.stayMonth[^`]*;filterType=stay/);
    console.log(contract);
    expect(contract, contract).toMatch(/payload\.theme[^`]*;filterType=theme/);
    expect(contract, contract).toMatch(/payload\.carrier[^`]*;filterType=carrier/);
    expect(contract, contract).toMatch(/payload\.venue[^`]*;filterType=venue/);
    expect(contract, contract).not.toContain("BAHAMAS;filterType=region");
    expect(contract, contract).not.toContain("2026-12;filterType=stay");
    expect(contract, contract).not.toContain('"MERRY;filterType=theme"');
    expect(contract, contract).not.toContain('"WW;filterType=carrier"');
    expect(contract, contract).not.toContain('"EXTRA;filterType=venue"');
  }, 30_000);
});
