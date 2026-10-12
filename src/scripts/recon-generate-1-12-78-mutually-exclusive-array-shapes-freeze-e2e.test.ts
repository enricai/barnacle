import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that same-endpoint drill captures whose facet arrays are different
 * shapes (4 elements of `<value>;filterId=<slug>` vs 6 elements of
 * `<VALUE>;filterType=<name>`, diverging at index 3) are not compared slot by
 * slot: the frozen-varying guard must key on element identity, so generation
 * exits 0 instead of aborting on `filters.3`. Generic retail fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.mutually-exclusive-array-shapes-fixture.example.com";
const DRILL_URL = `https://${OWN_BACKEND_HOST}/catalog/pricing/`;

const ID_STYLE_FILTERS = [
  "red;filterId=color-red",
  "xl;filterId=size-xl",
  "cotton;filterId=material-cotton",
  "sale;filterId=promo-sale",
];
const TYPE_STYLE_FILTERS = [
  "RED;filterType=color",
  "XL;filterType=size",
  "COTTON;filterType=material",
  "NIGHT;filterType=night",
  "PRIVATEISLAND;filterType=privateIsland",
  "SALE;filterType=promo",
];

function fixtureCaptures(): Capture[] {
  const primary = buildCapture({
    url: `https://${OWN_BACKEND_HOST}/catalog/search/`,
    requestPostData: JSON.stringify({ page: 1 }),
    responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
    timestamp: "2026-06-01T00:00:00.000Z",
  });
  const drill = (sku: string, filters: string[], timestamp: string): Capture =>
    buildCapture({
      url: `${DRILL_URL}?sku=${sku}`,
      requestPostData: JSON.stringify({ filters }),
      responseBody: { results: [{ sku, amount: 19.99 }] },
      timestamp,
    });
  return [
    primary,
    drill("sku-a", ID_STYLE_FILTERS, "2026-06-01T00:00:01.000Z"),
    drill("sku-b", TYPE_STYLE_FILTERS, "2026-06-01T00:00:02.000Z"),
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

describe("recon-generate CLI — mutually-exclusive facet-array shapes across same-endpoint drill captures", () => {
  it("generates contract.ts without a frozen-varying error on filters.3", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-shapes-freeze-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-shapes-freeze-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "search catalog" },
          { step: "drill into pricing", submitStep: true },
        ],
        submitEndpointPattern: "catalog/pricing",
        ownBackendHostnames: [OWN_BACKEND_HOST],
        foldReturn: {
          endpointPattern: "catalog/pricing",
          resultsPath: "results",
          joinFields: ["sku"],
        },
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).not.toContain("would freeze a value that varied");
    expect(output).not.toContain('"filters.3"');
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("/catalog/pricing/");
  }, 60_000);
});
