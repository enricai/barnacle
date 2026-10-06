import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that a declared navigateTo payloadField facet whose literal is an
 * element of an array-typed request field (`filters`) wins over a by-index
 * `payload.filters["N"]` accessor and over a wholesale
 * `JSON.stringify(payload.filters)`, at every REST call site. Generic retail
 * catalog fixture: brand/size/color facet elements plus a constant suffix
 * element, across three call sites.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-facet-differing-arrays-fixture.example.com";
const DELIMITER = ";src=facet";
const BRAND_TOKEN = "brandx-filters-9001";
const SIZE_TOKEN = "sizex-filters-9002";
const COLOR_TOKEN = "colorx-filters-9003";
const SUFFIX = "inStock=true";

function tagged(token: string): string {
  return `${token}${DELIMITER}`;
}

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/shop/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-06-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/shop/search-results/`,
      requestPostData: JSON.stringify({
        filters: [tagged(BRAND_TOKEN), tagged(SIZE_TOKEN), tagged(COLOR_TOKEN), SUFFIX],
      }),
      responseBody: { ok: true },
      timestamp: "2026-06-01T00:00:01.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/shop/search-summary/`,
      requestPostData: JSON.stringify({
        filters: ["extra-literal", tagged("plainone"), tagged("plaintwo")],
        summaryOnly: true,
      }),
      responseBody: { ok: true },
      timestamp: "2026-06-01T00:00:02.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/shop/search-refine/`,
      requestPostData: JSON.stringify({
        filters: ["other-literal", "another"],
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

describe("recon-generate CLI — filters arrays that differ per call site", () => {
  it("renders differing facet arrays per element at every call site, never wholesale or by index", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-facet-differing-arrays-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-facet-differing-arrays-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    const base = `https://${OWN_BACKEND_HOST}/#/shop`;
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the shop with the brand facet applied",
            navigateTo: `${base}/brand/${BRAND_TOKEN}`,
            payloadField: "BrandFacet",
          },
          {
            step: "navigate to the shop with the size facet applied",
            navigateTo: `${base}/brand/${BRAND_TOKEN}/size/${SIZE_TOKEN}`,
            payloadField: "SizeFacet",
          },
          {
            step: "navigate to the shop with the color facet applied",
            navigateTo: `${base}/brand/${BRAND_TOKEN}/size/${SIZE_TOKEN}/color/${COLOR_TOKEN}`,
            payloadField: "ColorFacet",
          },
          { step: "browse shop" },
          { step: "apply filters", submitStep: true },
        ],
        submitEndpointPattern: "shop/search",
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
    const bodies = extractCallSiteBodies(contract);

    for (const token of [BRAND_TOKEN, SIZE_TOKEN, COLOR_TOKEN]) {
      expect(contract).not.toContain(token);
    }
    expect(contract).not.toMatch(/payload\.filters\[/);

    const facetBody = bodies.get("/shop/search-results/");
    expect(facetBody, contract).toBeDefined();
    expect(facetBody).not.toContain("JSON.stringify(payload.filters)");
    for (const field of ["BrandFacet", "SizeFacet", "ColorFacet"]) {
      expect(facetBody).toContain(`payload.${field}`);
    }
    // Arrays carrying no declared facet pass through as the declared field.
    for (const path of ["/shop/search-summary/", "/shop/search-refine/"]) {
      const body = bodies.get(path);
      expect(body, contract).toBeDefined();
      expect(body).toContain("JSON.stringify(payload.filters)");
    }
    expect(contract).toContain("filters: multipartJsonObject(z.array(z.string()))");
    expect(contract).not.toContain("other-literal");
  }, 30_000);
});
