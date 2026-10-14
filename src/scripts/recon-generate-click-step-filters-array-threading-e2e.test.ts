import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { unreferencedDeclaredPayloadFields } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.click-step-filters-array-threading-fixture.example.com";

const FIVE_ELEMENTS = [
  "2026-12;filterType=date",
  "PARIS;filterType=destination",
  "BETA;filterType=theme",
  "GAMMA;filterType=vendor",
  "DELTA;filterType=extra",
];
const SIX_ELEMENTS = [...FIVE_ELEMENTS, "4;filterType=night"];

const DESTINATION_STEP =
  "Open the destination filter dropdown in the search bar and select the 'Paris' destination option, keeping the other filters that are already applied";
const NIGHTS_STEP =
  "Open the length of stay (number of nights) filter dropdown in the search bar and select the '4' nights option, keeping the other filters that are already applied";

/**
 * Proves, through the real `recon:generate` CLI, that a click-step
 * `payloadField` is threaded into a `;filterType=<kind>` array element, that
 * hash-style (navigateTo) facets still thread, and that a declared facet with
 * no request evidence is reported rather than silently ignored.
 */
function buildCaptures(filters: string[]): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/browse/`,
      requestPostData: JSON.stringify({ sort: "recent" }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/quote/`,
      requestPostData: JSON.stringify({ category: "gadgets", filters }),
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

const DECLARED_STEPS = [
  { step: "navigate", payloadField: "category" },
  { step: DESTINATION_STEP, payloadField: "destination" },
  { step: NIGHTS_STEP, payloadField: "nights" },
];

function generate(filters: string[]): { contract: string; output: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-click-step-filters-array-"));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, buildCaptures(filters));

  const siteId = `click-step-filters-array-threading-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        {
          step: "navigate to the gadgets category page",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/browse/gadgets`,
          payloadField: "category",
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
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status, output).toBe(0);
  return { contract: readFileSync(join(siteOutDir, "contract.ts"), "utf8"), output };
}

describe("recon-generate CLI — click-step facets threaded into a filters array", () => {
  it("threads destination and nights into their filterType elements and keeps the rest literal", () => {
    const { contract } = generate(SIX_ELEMENTS);

    expect(contract, contract).toMatch(/payload\.destination[^`]*;filterType=destination/);
    expect(contract, contract).toContain("toUpperCase()");
    expect(contract, contract).toMatch(/payload\.nights[^`]*;filterType=night/);
    expect(contract).not.toContain("PARIS;filterType=destination");
    for (const literal of [
      "2026-12;filterType=date",
      "BETA;filterType=theme",
      "GAMMA;filterType=vendor",
      "DELTA;filterType=extra",
    ]) {
      expect(contract, contract).toContain(literal);
    }
    expect(contract).toContain("payload.category");
    expect(unreferencedDeclaredPayloadFields(contract, "", DECLARED_STEPS)).toEqual([]);
    const order = [
      ";filterType=date",
      ";filterType=destination",
      ";filterType=theme",
      ";filterType=vendor",
      ";filterType=extra",
      ";filterType=night",
    ].map((kind) => contract.indexOf(kind));
    expect(
      order.every((at) => at >= 0),
      contract
    ).toBe(true);
    expect(order, "captured element order is preserved").toEqual([...order].sort((a, b) => a - b));
  }, 30_000);

  it("threads both facets into the quote-bar filters expression of the six-element body", () => {
    const { contract } = generate(SIX_ELEMENTS);
    const filtersExpression = contract.slice(contract.indexOf("filters"));

    expect(filtersExpression).toContain("payload.destination");
    expect(filtersExpression).toContain("payload.nights");
  }, 30_000);

  it("reports the nights field when no request body carries a night element", () => {
    const { contract, output } = generate(FIVE_ELEMENTS);

    expect(output).toContain("declared payloadField nights is a required schema field");
    expect(output).not.toContain("declared payloadField destination is a required schema field");
    expect(contract, contract).toMatch(/payload\.destination[^`]*;filterType=destination/);
    expect(contract).toContain("payload.category");
    expect(unreferencedDeclaredPayloadFields(contract, "", DECLARED_STEPS)).toEqual(["nights"]);
  }, 30_000);
});
