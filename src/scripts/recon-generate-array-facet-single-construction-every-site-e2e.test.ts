import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Pins that every facet-carrying array, required-only or optional-bearing,
 * renders through the one `${JSON.stringify([...])}` construction at every
 * REST call site, that a site whose array carries no facet passes the field
 * through as `payload.<field>`, and that a facet recurring inside a packed
 * string under a non-correlating key is spliced. Generic retail fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const HOST = "www.array-facet-single-construction-fixture.example.com";
const DELIMITER = "|ref=slug";
const ALPHA = "alphax-shop-1001";
const BETA = "betax-shop-1002";
const GAMMA = "gammax-shop-1003";
const PATHS = ["/s/site-a/", "/s/site-b/", "/s/site-c/", "/s/site-d/"];

function tagged(token: string): string {
  return `${token}${DELIMITER}`;
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function generate(): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-single-construction-"));
  const runRoot = join(workDir, "run");
  for (const dir of ["graphql", "replays", "aux"]) {
    mkdirSync(join(runRoot, dir), { recursive: true });
  }
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  const bodies: unknown[] = [
    { categories: ["type=plain", tagged(ALPHA), tagged(BETA)], q: `kind:shop|city:${ALPHA}` },
    { categories: [tagged(BETA), "other-literal", tagged(GAMMA), tagged(ALPHA)] },
    { categories: ["only-plain-one", "only-plain-two"], page: 2 },
    { categories: ["type=plain", tagged(ALPHA)], page: 3 },
  ];
  bodies.forEach((body, index) => {
    writeFileSync(
      join(runRoot, "graphql", `00${index}-capture.json`),
      JSON.stringify(
        buildCapture({
          url: `https://${HOST}${PATHS[index]}`,
          requestPostData: JSON.stringify(body),
          responseBody: { ok: true },
          timestamp: `2026-06-01T00:00:0${index}.000Z`,
        })
      )
    );
  });
  const siteId = `array-facet-single-construction-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  const base = `https://${HOST}/#/s`;
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        { step: "navigate with alpha", navigateTo: `${base}/${ALPHA}`, payloadField: "AlphaFacet" },
        {
          step: "navigate with beta",
          navigateTo: `${base}/${ALPHA}/${BETA}`,
          payloadField: "BetaFacet",
        },
        {
          step: "navigate with gamma",
          navigateTo: `${base}/${ALPHA}/${BETA}/${GAMMA}`,
          payloadField: "GammaFacet",
          optional: true,
        },
        { step: "search", submitStep: true },
      ],
      submitEndpointPattern: "s/site-d",
      requireSubmitEndpointMatch: true,
      ownBackendHostnames: [HOST],
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

/** Splits on the emitter's stable idiom because bodies nest backtick templates. */
function extractCallSiteBodies(contract: string): Map<string, string> {
  const bodies = new Map<string, string>();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: matching emitted source text, not a template.
  for (const chunk of contract.split("httpClient(`${payload.BaseUrl}").slice(1)) {
    const bodyStart = chunk.indexOf("body: `") + "body: `".length;
    bodies.set(
      chunk.slice(0, chunk.indexOf("`,")),
      chunk.slice(bodyStart, chunk.indexOf("`,\n      schema:"))
    );
  }
  return bodies;
}

describe("recon-generate CLI — one construction for every facet-carrying array", () => {
  it("renders every facet array through JSON.stringify and passes facet-free arrays through", () => {
    const contract = generate();
    const bodies = extractCallSiteBodies(contract);
    const body = (index: number): string => bodies.get(PATHS[index] ?? "") ?? "";

    for (const token of [ALPHA, BETA, GAMMA]) {
      expect(contract).not.toContain(token);
    }
    expect(contract).not.toContain("undefined");
    expect(contract).not.toMatch(/payload\.categories\[/);

    const facetSites: Record<number, string[]> = {
      0: ["AlphaFacet", "BetaFacet"],
      1: ["BetaFacet", "GammaFacet", "AlphaFacet"],
      3: ["AlphaFacet"],
    };
    for (const [index, fields] of Object.entries(facetSites)) {
      const text = body(Number(index));
      expect(text).toContain('"categories":${JSON.stringify([');
      expect(text).not.toContain("JSON.stringify(payload.categories)");
      for (const field of fields) expect(text).toContain(`payload.${field}${"}"}${DELIMITER}`);
    }
    expect(body(1)).toContain("...(payload.GammaFacet ? [");
    expect(body(0)).not.toContain("payload.GammaFacet");

    expect(body(2)).toContain('"categories":${JSON.stringify(payload.categories)}');
    expect(body(2)).not.toContain("only-plain");
    expect(contract).toMatch(/categories: multipartJsonObject\(z\.array\(z\.string\(\)\)\)/);
  }, 60_000);

  it("splices a facet recurring in a packed string under a non-correlating key", () => {
    const contract = generate();
    expect(extractCallSiteBodies(contract).get(PATHS[0] ?? "")).toContain(
      '"q":"kind:shop|city:${payload.AlphaFacet}"'
    );
  }, 60_000);
});
