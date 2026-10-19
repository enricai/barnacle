import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Contract: every flow-declared payloadField facet must either (a) be threaded
 * into every emitted request element that carries its value, in whichever
 * vocabulary the traffic uses, or (b) be reported as unthreaded. Here the
 * quoted click-step literal ('Lake') differs in case from the captured code
 * (LAKE) and the nights field maps to the singular `night` element kind.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.rental-quote-bar-declared-facets-fixture.example.com";
const BRAND_SLUG = "alpine-lodges";
const REGION_SLUG = "north-shore";

const DESTINATION_STEP =
  "Open the destination filter dropdown in the quote bar and select the 'Lake' destination option, keeping the other filters that are already applied";
const NIGHTS_STEP =
  "Open the stay length (number of nights) filter dropdown in the quote bar and select the '4' nights option, keeping the other filters that are already applied";

const BASE_ELEMENTS = [
  "2026-12;filterType=date",
  "LAKE;filterType=destination",
  "CABIN;filterType=theme",
  "PET;filterType=perk",
];
const ELEMENTS_WITH_NIGHTS = [
  "2026-12;filterType=date",
  "LAKE;filterType=destination",
  "CABIN;filterType=theme",
  "4;filterType=night",
  "PET;filterType=perk",
];

const HASH_BASE = `https://${OWN_BACKEND_HOST}/#/stays`;

const FLOW_STEPS = [
  {
    step: "navigate to the stays page with the brand applied",
    navigateTo: `${HASH_BASE}/Brand/${BRAND_SLUG}`,
    payloadField: "BrandFacet",
  },
  {
    step: "navigate to the stays page with the region applied",
    navigateTo: `${HASH_BASE}/Brand/${BRAND_SLUG}/Region/${REGION_SLUG}`,
    payloadField: "RegionFacet",
    optional: true,
  },
  { step: DESTINATION_STEP, payloadField: "destination" },
  { step: NIGHTS_STEP, payloadField: "nights" },
  { step: "submit the order", submitStep: true },
];

type Transport = "rest" | "graphql";

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function writeRest(capturesDir: string, elements: string[]): void {
  const bodies: Array<[string, unknown]> = [
    ["/stay-search/", { filters: [`${BRAND_SLUG};filterId=slug`, `${REGION_SLUG};filterId=slug`] }],
    ["/stay-quote-bar/", { filters: elements }],
    ["/submit/", { confirm: true }],
  ];
  bodies.forEach(([path, body], index) => {
    const capture = buildCapture({
      url: `https://${OWN_BACKEND_HOST}${path}`,
      requestPostData: JSON.stringify(body),
      responseBody: { ok: true },
      timestamp: `2026-01-01T00:00:0${index}.000Z`,
    });
    writeFileSync(
      join(capturesDir, `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
}

function writeGraphql(capturesDir: string, elements: string[]): void {
  const variables = {
    filters: elements,
    tags: [`${BRAND_SLUG};filterId=slug`, `${REGION_SLUG};filterId=slug`],
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
      responseBody: { stays: [{ id: "stay-1001" }] },
      operationName: "staySearch",
      query:
        "query staySearch($filters: [String!], $tags: [String!]) { stays(filters: $filters, tags: $tags) { id } }",
      variables,
      decodedParams: null,
    })
  );
}

function generate(transport: Transport, elements: string[]): { contract: string; output: string } {
  workDir = mkdtempSync(join(tmpdir(), `barnacle-quote-bar-declared-${transport}-`));
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  if (transport === "rest") writeRest(capturesDir, elements);
  else writeGraphql(capturesDir, elements);

  const siteId = `quote-bar-declared-${transport}-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: FLOW_STEPS,
      ...(transport === "rest"
        ? { submitEndpointPattern: "submit", requireSubmitEndpointMatch: true }
        : {}),
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

function assertContract(transport: Transport, elements: string[]): void {
  const { contract, output } = generate(transport, elements);
  const hasNights = elements === ELEMENTS_WITH_NIGHTS;

  expect(contract, contract).toMatch(/payload\.destination[^\x60]*;filterType=destination/);
  expect(contract, contract).not.toContain("LAKE;filterType=destination");
  if (hasNights) {
    expect(contract, contract).toMatch(/payload\.nights[^\x60]*;filterType=night/);
    expect(contract, contract).not.toContain("4;filterType=night");
  } else {
    expect(output).toContain("declared payloadField nights is read by no emitted request");
    expect(contract, contract).toMatch(/^\s*nights: z\.string\(\)\.optional\(\),/m);
    expect(contract, contract).not.toMatch(/^\s*nights: z\.string\(\),/m);
  }

  const order = elements.map((e) => contract.indexOf(`;filterType=${e.split(";filterType=")[1]}`));
  expect(
    order.every((at) => at >= 0),
    contract
  ).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
}

describe("recon-generate CLI — click-step facets quoted in a different case and kind spelling than the quote-bar array", () => {
  for (const transport of ["rest", "graphql"] as const) {
    it(`${transport}: threads declared facets when the nights element is observed`, () => {
      assertContract(transport, ELEMENTS_WITH_NIGHTS);
    }, 60_000);

    it(`${transport}: threads destination and reports nights unthreaded when it is unobserved`, () => {
      assertContract(transport, BASE_ELEMENTS);
    }, 60_000);
  }
});
