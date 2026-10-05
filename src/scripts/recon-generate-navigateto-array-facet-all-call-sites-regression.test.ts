import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Closes the report's Part 2 "only 1 of several facets, 1 of several call
 * sites" gap: every existing array-facet-splice regression test (mixed-
 * required-optional, cumulative, labeled-cumulative) proves every FACET
 * threads at its first/only call site, but none of them proves a facet set
 * recurring at MULTIPLE call sites — with each site referencing a DIFFERENT
 * subset of the same facets — gets spliced uniformly everywhere it appears,
 * not just at the first site encountered. Drives the real `recon:generate`
 * CLI with four navigateTo+payloadField facets (two required, two optional)
 * recurring as elements of one shared `tags` body field across three REST
 * call sites with three distinct compositions: all four facets present, a
 * required-only subset, and a required-plus-optional subset missing one
 * required facet — over a generic catalog/e-commerce domain fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.navigateto-array-facet-all-call-sites-fixture.example.com";
const DELIMITER = ";src=facet";

const REGION_TOKEN = "regionx-all-sites-8001";
const CATEGORY_TOKEN = "categoryx-all-sites-8002";
const SORT_ORDER_TOKEN = "sortorderx-all-sites-8003";
const TIER_TOKEN = "tierx-all-sites-8004";

function tagged(token: string): string {
  return `${token}${DELIMITER}`;
}

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-06-01T00:00:00.000Z",
    }),
    // Call site 1: the full array literal — all four facets present as
    // elements.
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/`,
      requestPostData: JSON.stringify({
        tags: [
          tagged(REGION_TOKEN),
          tagged(CATEGORY_TOKEN),
          tagged(SORT_ORDER_TOKEN),
          tagged(TIER_TOKEN),
        ],
      }),
      responseBody: { ok: true },
      timestamp: "2026-06-01T00:00:01.000Z",
    }),
    // Call site 2: a required-only subset — just region and category.
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-summary/`,
      requestPostData: JSON.stringify({
        tags: [tagged(REGION_TOKEN), tagged(CATEGORY_TOKEN)],
        summaryOnly: true,
      }),
      responseBody: { ok: true },
      timestamp: "2026-06-01T00:00:02.000Z",
    }),
    // Call site 3: a different subset — region plus both optional facets,
    // but missing category entirely.
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-refine/`,
      requestPostData: JSON.stringify({
        tags: [tagged(REGION_TOKEN), tagged(SORT_ORDER_TOKEN), tagged(TIER_TOKEN)],
        refine: true,
      }),
      responseBody: { ok: true },
      timestamp: "2026-06-01T00:00:03.000Z",
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

/**
 * Extracts the `body: \`...\`` template-literal content of each
 * `await httpClient(\`${payload.BaseUrl}<path>\`, { ... })` call in the
 * emitted contract, keyed by the call's URL path. Each body may itself
 * contain nested backtick template expressions (e.g.
 * `` `${payload.RegionFacet};src=facet` ``), so a naive `` /`([^`]*)`/ ``
 * regex would stop at the first nested backtick — splitting on the fixed
 * `httpClient(\`${payload.BaseUrl}` prefix and the fixed `` `,\n      schema: ``
 * suffix (the emitter's own stable idiom) avoids that.
 */
function extractCallSiteBodies(contract: string): Map<string, string> {
  const bodies = new Map<string, string>();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: matching against emitted source text, not a template.
  const chunks = contract.split("httpClient(`${payload.BaseUrl}").slice(1);
  for (const chunk of chunks) {
    const urlEnd = chunk.indexOf("`,");
    const url = chunk.slice(0, urlEnd);
    const bodyStart = chunk.indexOf("body: `") + "body: `".length;
    const bodyEnd = chunk.indexOf("`,\n      schema:");
    bodies.set(url, chunk.slice(bodyStart, bodyEnd));
  }
  return bodies;
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — four navigateTo array facets recurring with varying compositions across three call sites", () => {
  it("splices every present facet's own accessor at every call site that references it, not just the first", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-array-facet-all-call-sites-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `navigateto-array-facet-all-call-sites-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the catalog with the region facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/region/${REGION_TOKEN}`,
            payloadField: "RegionFacet",
          },
          {
            step: "navigate to the catalog with the category facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/region/${REGION_TOKEN}/category/${CATEGORY_TOKEN}`,
            payloadField: "CategoryFacet",
          },
          {
            step: "navigate to the catalog with the sortOrder facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/region/${REGION_TOKEN}/category/${CATEGORY_TOKEN}/sortOrder/${SORT_ORDER_TOKEN}`,
            payloadField: "SortOrderFacet",
            optional: true,
          },
          {
            step: "navigate to the catalog with the tier facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/region/${REGION_TOKEN}/category/${CATEGORY_TOKEN}/sortOrder/${SORT_ORDER_TOKEN}/tier/${TIER_TOKEN}`,
            payloadField: "TierFacet",
            optional: true,
          },
          { step: "browse catalog" },
          { step: "apply filters", submitStep: true },
        ],
        // Matches every /catalog/filter-* call site (results, summary,
        // refine) — truncated at the LAST match, so the whole chain survives
        // instead of just the first-matching endpoint.
        submitEndpointPattern: "catalog/filter",
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

    const bodies = extractCallSiteBodies(contract);
    const resultsBody = bodies.get("/catalog/filter-results/");
    const summaryBody = bodies.get("/catalog/filter-summary/");
    const refineBody = bodies.get("/catalog/filter-refine/");
    expect(resultsBody, contract).toBeDefined();
    expect(summaryBody, contract).toBeDefined();
    expect(refineBody, contract).toBeDefined();

    // No raw facet token survives frozen anywhere in the output, at any
    // call site.
    expect(contract).not.toContain(REGION_TOKEN);
    expect(contract).not.toContain(CATEGORY_TOKEN);
    expect(contract).not.toContain(SORT_ORDER_TOKEN);
    expect(contract).not.toContain(TIER_TOKEN);

    // No call site's `tags` array is left as a wholesale, unspliced
    // passthrough — the report's shape (2).
    expect(contract).not.toContain("JSON.stringify(payload.tags)");

    // No call site falls back to an indexed-but-unspliced element access —
    // the report's shape (3).
    expect(contract).not.toMatch(/payload\.tags\[/);

    // An omitted optional facet never splices the literal string
    // "undefined" into any call site's body.
    expect(contract).not.toContain("undefined");

    // Call site 1 (full literal, all four facets): both required facets
    // splice unconditionally, both optional facets splice conditionally.
    expect(resultsBody).toContain(`\${payload.RegionFacet}`);
    expect(resultsBody).toContain(`\${payload.CategoryFacet}`);
    expect(resultsBody).toContain(
      `...(payload.SortOrderFacet ? [\`\${payload.SortOrderFacet}${DELIMITER}\`] : [])`
    );
    expect(resultsBody).toContain(
      `...(payload.TierFacet ? [\`\${payload.TierFacet}${DELIMITER}\`] : [])`
    );

    // Call site 2 (required-only subset: region, category): both present
    // facets splice to their own accessor — proving the required-only
    // array-element splice path (recon-generate-navigateto-array-element-
    // facet-splice-e2e.test.ts) still fires at a call site OTHER than the
    // first one that referenced the shared field.
    expect(summaryBody).toContain(`\${payload.RegionFacet}`);
    expect(summaryBody).toContain(`\${payload.CategoryFacet}`);
    expect(summaryBody).not.toContain(`\${payload.SortOrderFacet}`);
    expect(summaryBody).not.toContain(`\${payload.TierFacet}`);

    // Call site 3 (region + both optional facets, missing category): the
    // present required facet splices unconditionally, both optional facets
    // splice conditionally, and the ABSENT facet (category) gets no
    // accessor at this site at all.
    expect(refineBody).toContain(`\${payload.RegionFacet}`);
    expect(refineBody).not.toContain(`\${payload.CategoryFacet}`);
    expect(refineBody).toContain(
      `...(payload.SortOrderFacet ? [\`\${payload.SortOrderFacet}${DELIMITER}\`] : [])`
    );
    expect(refineBody).toContain(
      `...(payload.TierFacet ? [\`\${payload.TierFacet}${DELIMITER}\`] : [])`
    );

    // The payload schema declares all four facet fields.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    expect(schema).toMatch(/ {2}RegionFacet: z\.string\(\),/);
    expect(schema).toMatch(/ {2}CategoryFacet: z\.string\(\),/);
    expect(schema).toMatch(/ {2}SortOrderFacet: z\.string\(\),/);
    expect(schema).toMatch(/ {2}TierFacet: z\.string\(\),/);
  }, 30_000);
});
