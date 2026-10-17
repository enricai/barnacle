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

const OWN_BACKEND_HOST = "www.catalog-hash-quote-bar-fixture.example.com";
const BRAND_SLUG = "acme-outdoor";
const COLOUR_SLUG = "forest-green";
const SIZE_SLUG = "medium";
const MATERIAL_SLUG = "recycled-nylon";
const SEASON_SLUG = "all-weather";

const CATEGORY_STEP =
  "Open the category filter dropdown in the toolbar and select the 'Shoes' category option, keeping the other filters that are already applied";
const COUNT_STEP =
  "Open the pack count filter dropdown in the toolbar and select the '4' count option, keeping the other filters that are already applied";

const TOOLBAR_ELEMENTS = [
  "2026-12;filterType=release",
  "SH;filterType=category",
  "WP;filterType=feature",
  "LT;filterType=weight",
  "EU;filterType=market",
];

const HASH_BASE = `https://${OWN_BACKEND_HOST}/#/catalog`;

const FLOW_STEPS = [
  {
    step: "navigate to the catalog with the brand applied",
    navigateTo: `${HASH_BASE}/Brand/${BRAND_SLUG}`,
    payloadField: "BrandFacet",
  },
  {
    step: "navigate to the catalog with the colour applied",
    navigateTo: `${HASH_BASE}/Brand/${BRAND_SLUG}/Colour/${COLOUR_SLUG}`,
    payloadField: "ColourFacet",
    optional: true,
  },
  {
    step: "navigate to the catalog with the size applied",
    navigateTo: `${HASH_BASE}/Brand/${BRAND_SLUG}/Colour/${COLOUR_SLUG}/Size/${SIZE_SLUG}`,
    payloadField: "SizeFacet",
    optional: true,
  },
  {
    step: "navigate to the catalog with the material applied",
    navigateTo: `${HASH_BASE}/Brand/${BRAND_SLUG}/Colour/${COLOUR_SLUG}/Size/${SIZE_SLUG}/Material/${MATERIAL_SLUG}`,
    payloadField: "MaterialFacet",
    optional: true,
  },
  {
    step: "navigate to the catalog with the season applied",
    navigateTo: `${HASH_BASE}/Brand/${BRAND_SLUG}/Colour/${COLOUR_SLUG}/Size/${SIZE_SLUG}/Material/${MATERIAL_SLUG}/Season/${SEASON_SLUG}`,
    payloadField: "SeasonFacet",
    optional: true,
  },
  { step: CATEGORY_STEP, payloadField: "category" },
  { step: COUNT_STEP, payloadField: "count" },
  { step: "submit the order", submitStep: true },
];

/**
 * Acceptance surface for the mixed capture set: slug bodies (filterId
 * vocabulary) and a quote-bar body (filterType vocabulary) in one run. A
 * payloadField declared on a click step must govern every element carrying
 * its value, and a declared field that governs nothing must not be required.
 */
function buildCaptures(): Capture[] {
  const bodies: Array<[string, unknown]> = [
    [
      "/catalog/search/",
      {
        filters: [
          `${BRAND_SLUG};filterId=slug`,
          `${COLOUR_SLUG};filterId=slug`,
          `${SIZE_SLUG};filterId=slug`,
          `${MATERIAL_SLUG};filterId=slug`,
          `${SEASON_SLUG};filterId=slug`,
        ],
      },
    ],
    ["/toolbar/", { filters: TOOLBAR_ELEMENTS }],
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

describe("recon-generate CLI — click-step facets with hash slug bodies and a toolbar body in one capture set", () => {
  it("governs every kind-suffixed element by its declared facet and emits no unread required field", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-catalog-hash-quote-bar-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, buildCaptures());

    const siteId = `catalog-hash-quote-bar-test-${process.pid}`;
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
    expect(unreferencedDeclaredPayloadFields(contract, browserFlow, declared), output).toEqual([]);

    expect(contract, contract).toMatch(/payload\.category[^\x60]*;filterType=category/);
    expect(contract, contract).not.toContain("SH;filterType=category");
    expect(contract, contract).not.toMatch(/^\s*count: z\.string\(\),/m);
    expect(contract, contract).toMatch(/count: z\.string\(\)\.optional\(\)/);
    const order = TOOLBAR_ELEMENTS.map((e) => e.split(";filterType=")[1]).map((kind) =>
      contract.indexOf(`;filterType=${kind}`)
    );
    expect(
      order.every((i) => i >= 0),
      contract
    ).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  }, 60_000);
});
