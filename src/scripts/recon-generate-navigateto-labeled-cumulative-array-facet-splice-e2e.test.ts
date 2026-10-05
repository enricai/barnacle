import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Closes the report's exact "1 of 5-7 facets, 1 of several call sites"
 * shape: a growing navigateTo hash where each step appends a `label/value`
 * SEGMENT PAIR (e.g. `.../ship/X` then `.../ship/X/sailMonth/Y`), not a bare
 * value. {@link extractNavigateToHashFragmentValue}'s cumulative-delta
 * extraction previously stripped only the leading separator off the new
 * suffix, leaving the appended LABEL segment glued to the value
 * (`"sailMonth/Y"` instead of `"Y"`) for every facet after the first — so
 * every facet past the first silently failed to correlate against any
 * capture and was dropped, at every call site that referenced it. Drives the
 * real `recon:generate` CLI over a generic catalog/e-commerce domain fixture
 * with the SAME three facets recurring as array elements at TWO distinct
 * call sites, proving the fix applies uniformly to every facet and every
 * site, not just the first of each.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.navigateto-labeled-cumulative-array-facet-splice-fixture.example.com";
const DELIMITER = ";src=facet";

const CATEGORY_TOKEN = "catx-labeled-cumulative-7001";
const BRAND_TOKEN = "brandx-labeled-cumulative-7002";
const SIZE_TOKEN = "sizex-labeled-cumulative-7003";

function fixtureCaptures(): Capture[] {
  const taggedElements = [
    `${CATEGORY_TOKEN}${DELIMITER}`,
    `${BRAND_TOKEN}${DELIMITER}`,
    `${SIZE_TOKEN}${DELIMITER}`,
  ];
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-06-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/`,
      requestPostData: JSON.stringify({ sort: "relevance", tags: taggedElements }),
      responseBody: { ok: true },
      timestamp: "2026-06-01T00:00:01.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-summary/`,
      requestPostData: JSON.stringify({ tags: taggedElements, summaryOnly: true }),
      responseBody: { ok: true },
      timestamp: "2026-06-01T00:00:02.000Z",
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

describe("recon-generate CLI — labeled cumulative-hash navigateTo facets shared across two call sites", () => {
  it("threads every facet's own accessor into every call site's array, not just the first facet/first site", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-labeled-cumulative-array-facet-splice-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `navigateto-labeled-cumulative-array-facet-splice-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the catalog with the category facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/category/${CATEGORY_TOKEN}`,
            payloadField: "CategoryFacet",
          },
          {
            step: "navigate to the catalog with the brand facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/category/${CATEGORY_TOKEN}/brand/${BRAND_TOKEN}`,
            payloadField: "BrandFacet",
          },
          {
            step: "navigate to the catalog with the size facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/category/${CATEGORY_TOKEN}/brand/${BRAND_TOKEN}/size/${SIZE_TOKEN}`,
            payloadField: "SizeFacet",
            optional: true,
          },
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

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    // No raw facet hash literal survives frozen anywhere in the output — a
    // pre-fix label-glued delta ("brand/<token>") never matches any captured
    // element, so the literal leaks through untouched.
    expect(contract).not.toContain(CATEGORY_TOKEN.concat(DELIMITER));
    expect(contract).not.toContain(BRAND_TOKEN.concat(DELIMITER));
    expect(contract).not.toContain(SIZE_TOKEN.concat(DELIMITER));

    // Both required facets splice to their own accessor — not just the
    // first-declared one.
    expect(contract).toContain(`\${payload.CategoryFacet}${DELIMITER}`);
    expect(contract).toContain(`\${payload.BrandFacet}${DELIMITER}`);

    // The optional facet's array element is conditionally spliced, never
    // emitting the literal string "undefined".
    expect(contract).not.toContain("undefined");
    expect(contract).toContain(
      `...(payload.SizeFacet ? [\`\${payload.SizeFacet}${DELIMITER}\`] : [])`
    );

    // Neither call site's `tags` array is left as a wholesale, unspliced
    // passthrough.
    expect(contract).not.toContain("JSON.stringify(payload.tags)");

    // The payload schema declares all three facet fields.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    expect(schema).toMatch(/ {2}CategoryFacet: z\.string\(\),/);
    expect(schema).toMatch(/ {2}BrandFacet: z\.string\(\),/);
    expect(schema).toMatch(/ {2}SizeFacet: z\.string\(\),/);
  }, 30_000);
});
