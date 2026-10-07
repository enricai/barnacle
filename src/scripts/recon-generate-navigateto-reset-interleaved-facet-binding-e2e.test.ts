import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that every navigateTo-declared payloadField facet binds to its own
 * `payload.<field>` regardless of its position or the hashless reset
 * navigations interleaved between facets. Each facet navigateTo carries a
 * cumulative comma-joined hash, so a binder that reads the whole hash (or is
 * reset by a hashless navigation) collapses facets onto one value.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.reset-interleaved-facet-binding-fixture.example.com";
const BASE_URL = `https://${OWN_BACKEND_HOST}/`;

const FACETS: ReadonlyArray<{ token: string; field: string; key: string }> = [
  { token: "apparel-q1", field: "DepartmentFacet", key: "slotOne" },
  { token: "footwear-q2", field: "CategoryFacet", key: "slotTwo" },
  { token: "crimson-q3", field: "ColorFacet", key: "slotThree" },
  { token: "medium-q4", field: "SizeFacet", key: "slotFour" },
  { token: "slimfit-q5", field: "FitFacet", key: "slotFive" },
  { token: "northwind-q6", field: "BrandFacet", key: "slotSix" },
  { token: "cotton-q7", field: "MaterialFacet", key: "slotSeven" },
];
const ARRAY_FACET = FACETS[1];
const NO_NAVIGATE_FIELD = "PromoFacet";

function cumulativeHash(uptoIndex: number): string {
  return FACETS.slice(0, uptoIndex + 1)
    .map((f) => f.token)
    .join(",");
}

function fixtureCaptures(): Capture[] {
  const filterBody: Record<string, unknown> = { sort: "relevance" };
  for (const facet of FACETS) filterBody[facet.key] = facet.token;
  const noise = ["alpha", "beta", "gamma"].map((name, i) =>
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/noise-${name}/`,
      requestPostData: JSON.stringify({ unrelated: `noise-value-${name}` }),
      responseBody: { ok: true },
      timestamp: `2026-02-01T00:00:0${i + 2}.000Z`,
    })
  );
  return [
    ...noise,
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-02-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/`,
      requestPostData: JSON.stringify({
        ...filterBody,
        departments: [ARRAY_FACET?.token, "other-q9"],
      }),
      responseBody: { ok: true },
      timestamp: "2026-02-01T00:00:01.000Z",
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

describe("recon-generate CLI — facets separated by hashless reset navigations", () => {
  it("binds every declared facet to its own payload.<field>, distinct per facet, with no cumulative literal surviving", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-reset-interleaved-facets-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `reset-interleaved-facet-binding-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          ...FACETS.flatMap((facet, index) => [
            {
              step: `navigate to the catalog with the ${facet.field} facet applied`,
              navigateTo: `${BASE_URL}#${cumulativeHash(index)}`,
              payloadField: facet.field,
            },
            { step: "reset to the catalog root", navigateTo: BASE_URL },
          ]),
          { step: "choose a promotion", payloadField: NO_NAVIGATE_FIELD },
          { step: "browse catalog" },
          { step: "apply filters", submitStep: true },
        ],
        submitEndpointPattern: "catalog/filter-results",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const bodyBlocks = [...contract.matchAll(/body: (`.*`),\s*\n\s*schema:/g)].map(
      (m) => m[1] ?? ""
    );
    expect(bodyBlocks.length, contract).toBeGreaterThan(0);
    const combinedBody = bodyBlocks.join("\n");

    const splices = FACETS.map((facet) => `\${payload.${facet.field}}`);
    for (const [index, splice] of splices.entries())
      expect(combinedBody, `${FACETS[index]?.field} missing in: ${combinedBody}`).toContain(splice);
    expect(new Set(splices).size).toBe(FACETS.length);

    for (const body of bodyBlocks) {
      for (const facet of FACETS) expect(body).not.toContain(facet.token);
      expect(body).not.toContain(cumulativeHash(1));
    }
    expect(combinedBody).not.toContain(`\${payload.${NO_NAVIGATE_FIELD}}`);

    const arrayBodies = bodyBlocks.filter((body) => body.includes("departments"));
    expect(arrayBodies.length, combinedBody).toBeGreaterThan(0);
    for (const body of arrayBodies) expect(body).toContain(`\${payload.${ARRAY_FACET?.field}}`);
  }, 30_000);
});
