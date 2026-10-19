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

const OWN_BACKEND_HOST = "www.catalog-report-wording-fixture.example.com";
const LINE_SLUG = "sunset-line";
const PORT_SLUG = "harbor-point";
const MONTH_SLUG = "december-2026";

const DESTINATION_STEP =
  "Open the destination filter dropdown in the quote bar and select the 'Orchard' destination option, keeping the other filters that are already applied";
const NIGHTS_STEP =
  "Open the cruise length (number of nights) filter dropdown in the quote bar and select the '4' nights option, keeping the other filters that are already applied";

const BASE_ELEMENTS = [
  "2026-12;filterType=date",
  "OR;filterType=destination",
  "SP;filterType=theme",
  "HB;filterType=ship",
  "PI;filterType=privateIsland",
];
const ELEMENTS_WITH_NIGHTS = [
  "2026-12;filterType=date",
  "OR;filterType=destination",
  "SP;filterType=theme",
  "4;filterType=night",
  "HB;filterType=ship",
  "PI;filterType=privateIsland",
];

const HASH_BASE = `https://${OWN_BACKEND_HOST}/#/catalog`;

const FLOW_STEPS = [
  {
    step: "navigate to the catalog with the line applied",
    navigateTo: `${HASH_BASE}/Line/${LINE_SLUG}`,
    payloadField: "LineFacet",
  },
  {
    step: "navigate to the catalog with the port applied",
    navigateTo: `${HASH_BASE}/Line/${LINE_SLUG}/Port/${PORT_SLUG}`,
    payloadField: "PortFacet",
    optional: true,
  },
  {
    step: "navigate to the catalog with the month applied",
    navigateTo: `${HASH_BASE}/Line/${LINE_SLUG}/Port/${PORT_SLUG}/Month/${MONTH_SLUG}`,
    payloadField: "MonthFacet",
    optional: true,
  },
  { step: DESTINATION_STEP, payloadField: "destination" },
  { step: NIGHTS_STEP, payloadField: "nights" },
  { step: "submit the order", submitStep: true },
];

function buildCaptures(elements: string[]): Capture[] {
  const bodies: Array<[string, unknown]> = [
    [
      "/catalog-search/",
      {
        filters: [
          `${LINE_SLUG};filterId=slug`,
          `${PORT_SLUG};filterId=slug`,
          `${MONTH_SLUG};filterId=slug`,
        ],
      },
    ],
    ["/catalog-quote-bar/", { filters: elements }],
    ["/submit/", { confirm: true }],
  ];
  return bodies.map(([path, body], index) =>
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}${path}`,
      requestPostData: JSON.stringify(body),
      responseBody: { ok: true },
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

function runVariant(elements: string[], label: string): void {
  workDir = mkdtempSync(join(tmpdir(), `barnacle-catalog-report-${label}-`));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, buildCaptures(elements));

  const siteId = `catalog-report-${label}-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: FLOW_STEPS,
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

  const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
  const browserFlow = readFileSync(join(siteOutDir, "flows", "browser-flow.ts"), "utf8");
  const declared = FLOW_STEPS.filter((s) => s.payloadField).map((s) => ({
    step: s.step,
    payloadField: s.payloadField as string,
  }));
  const unreferenced = unreferencedDeclaredPayloadFields(contract, browserFlow, declared);

  expect(contract, contract).toMatch(/payload\.destination[^\x60]*;filterType=destination/);
  expect(contract, contract).not.toContain("OR;filterType=destination");
  if (elements === ELEMENTS_WITH_NIGHTS) {
    expect(contract, contract).toMatch(/payload\.nights[^\x60]*;filterType=night/);
    expect(contract, contract).not.toContain("4;filterType=night");
  } else {
    expect(output).toContain("declared payloadField nights is read by no emitted request");
    expect(contract, contract).toMatch(/^\s*nights: z\.string\(\)\.optional\(\),/m);
    expect(contract, contract).not.toMatch(/^\s*nights: z\.string\(\),/m);
  }
  const order = elements
    .map((e) => e.split(";filterType=")[1])
    .map((kind) => contract.indexOf(`;filterType=${kind}`));
  expect(
    order.every((i) => i >= 0),
    contract
  ).toBe(true);
  expect([...order].sort((x, y) => x - y)).toEqual(order);
  if (elements === ELEMENTS_WITH_NIGHTS) expect(unreferenced, output).toEqual([]);
}

describe("recon-generate CLI — click-step facets across slug and code vocabularies, with and without a nights element", () => {
  it("threads declared facets into every element when the nights element is absent", () => {
    runVariant(BASE_ELEMENTS, "no-nights");
  }, 60_000);

  it("threads declared facets into every element when nights sits between theme and ship", () => {
    runVariant(ELEMENTS_WITH_NIGHTS, "nights");
  }, 60_000);
});
