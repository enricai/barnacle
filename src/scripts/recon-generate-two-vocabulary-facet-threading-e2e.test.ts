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

const OWN_BACKEND_HOST = "www.two-vocabulary-facet-threading-fixture.example.com";

const FILTERS = [
  "2026-12;filterType=date",
  "WW;filterType=warehouse",
  "SHOES;filterType=category",
  "M;filterType=size",
];

const CATEGORY_STEP =
  "Open the category filter dropdown in the catalogue toolbar and select the 'Shoes' category option, keeping the other filters that are already applied";
const SIZE_STEP =
  "Open the size filter dropdown in the catalogue toolbar and select the 'M' size option, keeping the other filters that are already applied";

/**
 * Pins the contract that a declared facet bound by navigateTo hash slugs and
 * also carried in a kind-suffixed `filters` array element is threaded into
 * that element in the caller's vocabulary, alongside click-step facets.
 */
function buildCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/browse/`,
      requestPostData: JSON.stringify({ sort: "recent" }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/quote/`,
      requestPostData: JSON.stringify({ filters: FILTERS }),
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
  { step: "navigate", payloadField: "month" },
  { step: "navigate", payloadField: "warehouse" },
  { step: CATEGORY_STEP, payloadField: "category" },
  { step: SIZE_STEP, payloadField: "size" },
];

function generate(): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-two-vocabulary-facet-"));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, buildCaptures());

  const siteId = `two-vocabulary-facet-threading-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        {
          step: "navigate to the catalogue for a month",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/catalogue/december`,
          payloadField: "month",
        },
        {
          step: "navigate to the catalogue for a warehouse",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/catalogue/december/west`,
          payloadField: "warehouse",
        },
        { step: CATEGORY_STEP, payloadField: "category" },
        { step: SIZE_STEP, payloadField: "size" },
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
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

describe("recon-generate CLI — slug-bound facets threaded into a kind-suffixed array", () => {
  it("threads every declared facet into its filterType element and leaves no captured literal", () => {
    const contract = generate();

    expect(contract, contract).toMatch(/payload\.month[^`]*;filterType=date/);
    expect(contract, contract).toMatch(/payload\.warehouse[^`]*;filterType=warehouse/);
    expect(contract, contract).toMatch(/payload\.category[^`]*;filterType=category/);
    expect(contract, contract).toMatch(/payload\.size[^`]*;filterType=size/);
    for (const literal of FILTERS) {
      expect(contract, contract).not.toContain(literal);
    }
    expect(unreferencedDeclaredPayloadFields(contract, "", DECLARED_STEPS)).toEqual([]);
  }, 30_000);
});
