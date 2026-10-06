import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that all five declared navigateTo facets are threaded into the
 * `filters` array at every call site that carries them (arrays of differing
 * length), with a conditional spread for the one optional facet, no
 * wholesale `JSON.stringify(payload.filters)` passthrough, no by-index
 * accessor on the facet-owned array and no surviving facet literal.
 * Generic hotel-search fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-facet-all-facets-uniform-fixture.example.com";
const DELIMITER = ";kind=slug";
const TOKENS = {
  CityFacet: "cityx-stay-8001",
  BrandFacet: "brandx-stay-8002",
  AmenityFacet: "amenityx-stay-8003",
  RatingFacet: "ratingx-stay-8004",
  NeighborhoodFacet: "hoodx-stay-8005",
} as const;
const SITE_PATHS = ["/stay/search-a/", "/stay/search-b/", "/stay/search-c/", "/stay/search-d/"];
const SUFFIX = "currency=usd";

function tagged(token: string): string {
  return `${token}${DELIMITER}`;
}

function fixtureCaptures(): Capture[] {
  const t = Object.values(TOKENS).map(tagged);
  const bodies: unknown[] = [
    { filters: ["type=hotel", t[0], t[1], t[2], t[3], t[4], SUFFIX] },
    { filters: [t[0], t[1], t[2], t[3], t[4]], refine: true },
    { filters: ["sort=price", t[4], t[0], t[1], t[2], t[3], SUFFIX, "page=1"], summaryOnly: true },
    { filters: ["lang=any", t[1], t[0], t[3], t[2], t[4]], extra: 1 },
  ];
  return bodies.map((body, index) =>
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}${SITE_PATHS[index]}`,
      requestPostData: JSON.stringify(body),
      responseBody: { ok: true },
      timestamp: `2026-06-01T00:00:0${index}.000Z`,
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

describe("recon-generate CLI — every facet at every call site", () => {
  it("threads all declared facets into the filters array at all four sites", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-facet-all-uniform-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-facet-all-uniform-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    const base = `https://${OWN_BACKEND_HOST}/#/stay`;
    const fields = Object.keys(TOKENS) as (keyof typeof TOKENS)[];
    const steps = fields.map((field, index) => ({
      step: `navigate with ${field} applied`,
      navigateTo: `${base}/${fields
        .slice(0, index + 1)
        .map((f) => TOKENS[f])
        .join("/")}`,
      payloadField: field,
      ...(field === "NeighborhoodFacet" ? { optional: true } : {}),
    }));
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [...steps, { step: "search stays", submitStep: true }],
        submitEndpointPattern: "stay/search-d",
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

    for (const token of Object.values(TOKENS)) {
      expect(contract).not.toContain(token);
    }
    expect(contract).not.toMatch(/JSON\.stringify\(payload\.filters\)/);
    expect(contract).not.toMatch(/payload\.filters\[/);

    for (const path of SITE_PATHS) {
      const body = bodies.get(path);
      expect(body, contract).toBeDefined();
      for (const field of fields.filter((f) => f !== "NeighborhoodFacet")) {
        expect(body).toContain(`\${payload.${field}}`);
      }
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      expect(body).toContain("...(payload.NeighborhoodFacet ? [`${payload.NeighborhoodFacet}");
      expect(body).toContain(DELIMITER);
    }
    expect(bodies.get(SITE_PATHS[0] ?? "")).toContain("type=hotel");
    expect(bodies.get(SITE_PATHS[2] ?? "")).toContain("page=1");
  }, 30_000);
});
