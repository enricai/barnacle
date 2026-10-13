import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that a fold drill's body threads EVERY declared navigateTo facet even
 * when the facets are spread over differently shaped arrays of the same
 * endpoint (1..4 `<value>;filterId=<slug>` elements, then 5..6
 * `<VALUE>;filterType=<name>` elements): the repeat captures are absorbed into
 * the one representative drill, so a short first shape must not hide the
 * facets only later shapes carry, in any capture order. Generic retail fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.absorbed-shape-facets-fixture.example.com";
const DRILL_URL = `https://${OWN_BACKEND_HOST}/catalog/pricing/`;

const ID_STYLE_FILTERS = [
  "red;filterId=colorRed",
  "xl;filterId=sizeXl",
  "cotton;filterId=materialCotton",
  "sale;filterId=promoSale",
];
const TYPE_STYLE_FILTERS = [
  ...ID_STYLE_FILTERS.slice(0, 3),
  "NIGHT;filterType=night",
  "GARDEN;filterType=garden",
];
const FACET_TOKENS = ["red", "xl", "cotton", "sale", "NIGHT", "GARDEN"];

const SHAPES = [
  ID_STYLE_FILTERS.slice(0, 1),
  ID_STYLE_FILTERS.slice(0, 2),
  ID_STYLE_FILTERS.slice(0, 3),
  ID_STYLE_FILTERS,
  TYPE_STYLE_FILTERS.slice(0, 5),
];

/** Distinct per shape so the repeat drill captures keep distinct URLs. */
function drillCaptures(shapes: string[][]): Capture[] {
  const primary = buildCapture({
    url: `https://${OWN_BACKEND_HOST}/catalog/search/`,
    requestPostData: JSON.stringify({ page: 1 }),
    responseBody: { results: shapes.map((_, index) => ({ sku: `sku-${index}` })) },
    timestamp: "2026-06-01T00:00:00.000Z",
  });
  const drills = shapes.map((filters, index) =>
    buildCapture({
      url: `${DRILL_URL}?sku=sku-${index}&shape${filters.length}=ok`,
      requestPostData: JSON.stringify({ filters }),
      responseBody: { results: [{ sku: `sku-${index}`, amount: 19.99 }] },
      timestamp: `2026-06-01T00:00:0${index + 1}.000Z`,
    })
  );
  return [primary, ...drills];
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

function generateContract(shapes: string[][], label: string): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-absorbed-shape-facets-"));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, drillCaptures(shapes));

  const siteId = `absorbed-shape-facets-${label}-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        ...FACET_TOKENS.map((token, index) => ({
          step: `pick ${token}`,
          navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${token}`,
          payloadField: `Facet${index}`,
        })),
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
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

function drillBody(contract: string): string {
  const line = contract.split("\n").find((candidate) => candidate.includes('body: `{"filters"'));
  expect(line, "drill body line").toBeDefined();
  return line as string;
}

describe("recon-generate CLI — facets spread over differently shaped same-endpoint drill arrays", () => {
  it("threads every declared facet into the drill body, first shape shortest", () => {
    const body = drillBody(generateContract(SHAPES, "forward"));
    FACET_TOKENS.forEach((_, index) => {
      expect(body).toContain(`payload.Facet${index}`);
    });
  }, 60_000);

  it("threads every declared facet into the drill body, first shape longest", () => {
    const body = drillBody(generateContract([...SHAPES].reverse(), "reversed"));
    FACET_TOKENS.forEach((_, index) => {
      expect(body).toContain(`payload.Facet${index}`);
    });
  }, 60_000);

  it("keeps the facets of the representative shape required and conditions the rest", () => {
    const body = drillBody(generateContract(SHAPES, "optionality"));
    expect(body).toContain("payload.Facet0};filterId=colorRed`");
    expect(body).not.toContain("...(payload.Facet0 ?");
    expect(body).toContain("...(payload.Facet4 ? [`");
  }, 60_000);
});
