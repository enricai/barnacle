import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that all seven declared navigateTo payloadField facets reach every
 * `filters` call site. Three facets recur literally in bodies; four are
 * derived only from cumulative hash diffs and never appear verbatim, and
 * noisy extra captures make positional correlation ambiguous. Sites differ in
 * form: full array, array with no resolved facet element, array with one
 * index-varying element, and a would-be wholesale / by-index site.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-facet-unresolved-noisy-fixture.example.com";
const DELIMITER = ";kind=slug";
const LITERAL_TOKENS = {
  CityFacet: "cityx-stay-8101",
  BrandFacet: "brandx-stay-8102",
  AmenityFacet: "amenityx-stay-8103",
} as const;
const HASH_ONLY_TOKENS = {
  RatingFacet: "ratingx-hash-9101",
  NeighborhoodFacet: "hoodx-hash-9102",
  ZoneFacet: "zonex-hash-9103",
  TierFacet: "tierx-hash-9104",
} as const;
const TOKENS: Record<string, string> = { ...LITERAL_TOKENS, ...HASH_ONLY_TOKENS };
const OPTIONAL_FIELDS = ["RatingFacet", "ZoneFacet", "TierFacet"];
const SITE_PATHS = ["/stay/search-a/", "/stay/search-b/", "/stay/search-c/", "/stay/search-d/"];

function tagged(token: string): string {
  return `${token}${DELIMITER}`;
}

const BODY_TOKENS = [
  HASH_ONLY_TOKENS.RatingFacet,
  HASH_ONLY_TOKENS.NeighborhoodFacet,
  HASH_ONLY_TOKENS.ZoneFacet,
  HASH_ONLY_TOKENS.TierFacet,
];

function fixtureCaptures(): Capture[] {
  const c = Object.values(LITERAL_TOKENS).map(tagged);
  const h = BODY_TOKENS.map(tagged);
  const bodies: unknown[] = [
    { filters: ["type=hotel", c[0], c[1], c[2], h[0], h[1], h[2], h[3], "currency=usd"] },
    { filters: ["sort=price", "page=1"], refine: true },
    { filters: ["lang=any", h[2], c[2], h[1], c[0], h[3], c[1], h[0], "x=1", "y=2"], extra: 1 },
    { filters: [h[3], c[1], c[0], h[2], c[2], h[0], h[1]], summaryOnly: true },
  ];
  const noise = [
    { filters: ["type=hotel", c[0], h[1]], probe: 1 },
    { filters: ["type=hotel", c[0], c[1], h[0], h[2], h[3]], probe: 2 },
  ];
  return [...noise, ...bodies].map((body, index) =>
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}${index < noise.length ? "/stay/noise/" : SITE_PATHS[index - noise.length]}`,
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

function runGenerate(siteId: string, runRoot: string): string {
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir ?? "", "contract.ts"), "utf8");
}

describe("recon-generate CLI — unresolved and noisy facets at every site", () => {
  it("splices every declared facet at every array call site", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-facet-unresolved-noisy-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-facet-unresolved-noisy-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    const base = `https://${OWN_BACKEND_HOST}/#/stay`;
    const fields = Object.keys(TOKENS);
    const steps = fields.map((field, index) => ({
      step: `navigate with ${field} applied`,
      navigateTo: `${base}/${fields
        .slice(0, index + 1)
        .map((f) => TOKENS[f])
        .join("/")}`,
      payloadField: field,
      ...(OPTIONAL_FIELDS.includes(field) ? { optional: true } : {}),
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

    const contract = runGenerate(siteId, runRoot);
    const bodies = extractCallSiteBodies(contract);

    for (const token of Object.values(TOKENS)) {
      expect(contract).not.toContain(token);
    }
    expect(contract).not.toMatch(/JSON\.stringify\(payload\.filters\)/);
    expect(contract).not.toMatch(/payload\.filters\[/);

    for (const field of fields) {
      const refs = contract
        .split("\n")
        .filter((l) => l.includes(`payload.${field}`) && !/z\./.test(l));
      expect(refs.length, `${field}\n${contract}`).toBeGreaterThan(0);
    }
    expect(bodies.get(SITE_PATHS[1] ?? ""), contract).toContain("sort=price");
    // The facet-free site has no element to splice into, so it is excluded.
    for (const path of SITE_PATHS.filter((p) => p !== SITE_PATHS[1])) {
      const body = bodies.get(path);
      expect(body, contract).toBeDefined();
      for (const field of fields) {
        expect(body, `${path} ${field}\n${contract}`).toContain(`payload.${field}`);
      }
      for (const field of OPTIONAL_FIELDS) {
        expect(body).toContain(`...(payload.${field} ? [`);
      }
    }
  }, 60_000);

  it("splices a hash-differing optional facet at every site alongside noisy captures", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-facet-unresolved-correlated-"));
    const runRoot = join(workDir, "run");
    const hashToken = "hashx-stay-9901";
    const bodyToken = "bodyx-code-7901";
    const city = tagged(LITERAL_TOKENS.CityFacet);
    const bodies: unknown[] = [
      { filters: ["type=hotel", city] },
      { filters: ["type=hotel", city, tagged(bodyToken)] },
      { filters: [tagged(bodyToken), city], refine: true },
      { filters: ["sort=price", city, tagged(bodyToken), "page=1"] },
    ];
    writeRunDir(
      runRoot,
      bodies.map((body, index) =>
        buildCapture({
          url: `https://${OWN_BACKEND_HOST}${SITE_PATHS[index]}`,
          requestPostData: JSON.stringify(body),
          responseBody: { ok: true },
          timestamp: `2026-06-01T00:00:0${index}.000Z`,
        })
      )
    );

    const siteId = `array-facet-unresolved-correlated-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    const base = `https://${OWN_BACKEND_HOST}/#/stay`;
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate with CityFacet applied",
            navigateTo: `${base}/${LITERAL_TOKENS.CityFacet}`,
            payloadField: "CityFacet",
          },
          {
            step: "navigate with CodeFacet applied",
            navigateTo: `${base}/${LITERAL_TOKENS.CityFacet}/${hashToken}`,
            payloadField: "CodeFacet",
            optional: true,
          },
          { step: "search stays", submitStep: true },
        ],
        submitEndpointPattern: "stay/search-d",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const contract = runGenerate(siteId, runRoot);
    const callBodies = extractCallSiteBodies(contract);

    expect(contract).not.toContain(bodyToken);
    expect(contract).not.toMatch(/JSON\.stringify\(payload\.filters\)/);
    for (const path of SITE_PATHS.slice(1)) {
      expect(callBodies.get(path)).toContain("payload.CodeFacet");
    }
  }, 60_000);
});
