import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Closes the REST-side half of the report's optionality sub-gap: a
 * navigateTo-declared `payloadField` whose extracted hash literal recurs as
 * one element of an array field (not the `key:value` facet-string grammar)
 * must drop its own element — not freeze a literal `undefined` — when its
 * binding is `optional: true` and the caller omits the field at runtime.
 * Drives the real `recon:generate` CLI over a generic catalog/e-commerce
 * domain fixture, mirroring
 * recon-generate-navigateto-array-element-facet-splice-e2e.test.ts's
 * scaffolding, with one optional facet and one required sibling facet
 * sharing the same array.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.navigateto-array-element-optional-facet-splice-fixture.example.com";
const CATEGORY_HASH_TOKEN = "catx-array-optional-facet-hash-8842";
const BRAND_HASH_TOKEN = "brandx-array-required-facet-hash-9153";
const SOURCE_ID = "urlFriendlyId";

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-04-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/`,
      requestPostData: JSON.stringify({
        sort: "relevance",
        tags: [
          "in-stock",
          `${CATEGORY_HASH_TOKEN};sourceId=${SOURCE_ID}`,
          `${BRAND_HASH_TOKEN};sourceId=${SOURCE_ID}`,
          "free-shipping",
        ],
      }),
      responseBody: { ok: true },
      timestamp: "2026-04-01T00:00:01.000Z",
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

describe("recon-generate CLI — navigateTo array-element facet splice with an optional sibling facet", () => {
  it("drops the optional facet's element conditionally instead of emitting the literal string 'undefined', while the required sibling stays unconditional", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-array-element-optional-facet-splice-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `navigateto-array-element-optional-facet-splice-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the catalog with the category facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${CATEGORY_HASH_TOKEN}`,
            payloadField: "CategoryFacet",
            optional: true,
          },
          {
            step: "navigate to the catalog with the brand facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${CATEGORY_HASH_TOKEN}/${BRAND_HASH_TOKEN}`,
            payloadField: "BrandFacet",
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

    // The raw navigateTo hash literals must never survive frozen anywhere in
    // the emitted source — every occurrence was rewritten to a payload
    // accessor, whether required or optional.
    expect(contract).not.toContain(CATEGORY_HASH_TOKEN);
    expect(contract).not.toContain(BRAND_HASH_TOKEN);

    // An omitted optional facet must never splice the literal string
    // "undefined" into the body.
    expect(contract).not.toContain("undefined");

    // The optional facet's element is conditionally included — a spread
    // guarded on payload.CategoryFacet truthiness, the same structural
    // convention spliceFacetsIntoStringVariable already uses for the
    // key:value grammar (`...(payload.<field> ? [...] : [])`).
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on literal generated template-literal source, not interpolating here.
    expect(contract).toContain("...(payload.CategoryFacet ? [`${payload.CategoryFacet}");

    // The required sibling facet is still spliced unconditionally as
    // payload.<Field> (non-regression against the #515/#516 fixes) — not
    // wrapped in a conditional spread.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on literal generated template-literal source, not interpolating here.
    expect(contract).toContain("`${payload.BrandFacet}");
    expect(contract).not.toContain("...(payload.BrandFacet ?");

    // The payload schema marks the optional facet `.optional()` while the
    // required sibling facet stays required.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    expect(schema).toMatch(/CategoryFacet: z\.string\(\)\.optional\(\),/);
    expect(schema).toMatch(/ {2}BrandFacet: z\.string\(\),/);
  }, 30_000);
});
