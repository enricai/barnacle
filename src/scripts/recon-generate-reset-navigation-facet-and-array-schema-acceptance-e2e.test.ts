import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Acceptance pin for the combined behavior on a generic flow: hashless reset
 * navigations between cumulative comma-joined facet steps, an array-of-objects
 * field indexed by the bodies, and several call sites. Every declared facet
 * must be spliced as `payload.<field>` at every call site that carries it, the
 * owned array must have no passthrough or by-index accessor, and the emitted
 * contract must typecheck.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.reset-facet-array-schema-acceptance-fixture.example.com";
const BASE_URL = `https://${OWN_BACKEND_HOST}/`;
const DELIMITER = ";kind=slug";
const SITE_PATHS = ["/shop/query-a/", "/shop/query-b/", "/shop/query-c/", "/shop/query-d/"];

const REQUIRED_FACET = { field: "CategoryFacet", token: "categoryx-retail-7001" };
const OPTIONAL_FACETS: ReadonlyArray<{ field: string; token: string }> = [
  { field: "BrandFacet", token: "brandx-retail-7002" },
  { field: "RegionFacet", token: "regionx-retail-7003" },
];
const ALL_FACETS = [REQUIRED_FACET, ...OPTIONAL_FACETS];

function tagged(token: string): string {
  return `${token}${DELIMITER}`;
}

function cumulativeHash(uptoIndex: number): string {
  return ALL_FACETS.slice(0, uptoIndex + 1)
    .map((f) => f.token)
    .join(",");
}

function fixtureCaptures(): Capture[] {
  const category = tagged(REQUIRED_FACET.token);
  const brand = tagged(OPTIONAL_FACETS[0]?.token ?? "");
  const sorts = [
    { criteria: "price", order: "ASC", region: "MI" },
    { criteria: category, order: "ASC", region: "MI" },
  ];
  const bodies: unknown[] = [
    { sorts, filters: [`a${DELIMITER}`, category, `b${DELIMITER}`] },
    { sorts, filters: [`a${DELIMITER}`, category, brand, `b${DELIMITER}`] },
    { filters: [brand, `winter-2026${DELIMITER}`, category] },
    { filters: [category, brand], page: 1, storeRegion: OPTIONAL_FACETS[1]?.token },
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

/** Splits on the emitter's stable idiom because bodies can nest backtick templates. */
function extractCallSiteBodies(contract: string): Map<string, string> {
  const bodies = new Map<string, string>();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: matching emitted source text, not a template.
  const chunks = contract.split("httpClient(`${payload.BaseUrl}").slice(1);
  for (const chunk of chunks) {
    const url = chunk.slice(0, chunk.indexOf("`,"));
    const bodyStart = chunk.indexOf("body: `") + "body: `".length;
    const bodyEnd = chunk.indexOf("`,\n      schema:");
    bodies.set(url, chunk.slice(bodyStart, bodyEnd));
  }
  return bodies;
}

/** Returns the PayloadSchema line(s) declaring `field`, up to the next top-level key. */
function schemaFieldText(contract: string, field: string): string {
  const schema = contract.match(
    /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
  );
  const text = schema?.[0] ?? "";
  return text.match(new RegExp(` {2}${field}:[\\s\\S]*?(?=\\n {2}\\S|\\n\\}\\))`))?.[0] ?? "";
}

let workDir: string | null = null;
let siteOutDir: string | null = null;
let tsconfigPath: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  if (tsconfigPath) rmSync(tsconfigPath, { force: true });
  workDir = null;
  siteOutDir = null;
  tsconfigPath = null;
});

describe("recon-generate CLI + tsc — reset-navigation facets and array schema acceptance", () => {
  it("splices every facet at every call site, keeps accessors admitted by the schema, and typechecks", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }
    workDir = mkdtempSync(join(tmpdir(), "barnacle-reset-facet-array-acceptance-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `reset-facet-array-acceptance-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          ...ALL_FACETS.flatMap((facet, index) => [
            {
              step: `navigate to the shop with the ${facet.field} facet applied`,
              navigateTo: `${BASE_URL}#${cumulativeHash(index)}`,
              payloadField: facet.field,
              ...(index === 0 ? {} : { optional: true }),
            },
            { step: "reset to the shop root", navigateTo: BASE_URL },
          ]),
          { step: "browse shop" },
          { step: "query shop", submitStep: true },
        ],
        submitEndpointPattern: "shop/query-d",
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
    expect(bodies.size, contract).toBe(SITE_PATHS.length);

    for (const [path, body] of bodies) {
      const withoutDefaults = body.replace(/\?\? "[^"]*"/g, "");
      for (const facet of ALL_FACETS) expect(withoutDefaults, path).not.toContain(facet.token);
    }
    expect(contract).not.toMatch(/JSON\.stringify\(payload\.filters\)/);
    expect(contract).not.toMatch(/payload\.filters\[/);
    expect(contract).not.toMatch(/payload\.sorts(?!\[)/);

    const category = `\${payload.${REQUIRED_FACET.field}}`;
    for (const path of SITE_PATHS) {
      expect(bodies.get(path) ?? "", `${path}: ${contract}`).toContain(category);
    }
    for (const path of SITE_PATHS.slice(1)) {
      expect(bodies.get(path) ?? "", path).toContain("payload.BrandFacet");
    }
    const lastBody = bodies.get(SITE_PATHS[3] ?? "") ?? "";
    expect(lastBody, contract).toContain("payload.RegionFacet");
    expect(contract).toMatch(/\.\.\.\(payload\.(?:Brand|Region)Facet/);

    const sortsText = schemaFieldText(contract, "sorts");
    expect(sortsText, contract).toMatch(/z\.array\(\s*z\.object/);
    expect(sortsText).not.toMatch(/z\.string\(\)/);
    const indexed = [...contract.matchAll(/payload\.(\w+)\["\d+"\]!\.\w+/g)].map((m) => m[1] ?? "");
    for (const field of new Set(indexed)) {
      const decl = schemaFieldText(contract, field);
      expect(decl, `${field} indexed in body but not declared:\n${contract}`).not.toBe("");
      expect(decl, `${field} declared as scalar:\n${decl}`).not.toMatch(/z\.string\(\)/);
      expect(decl).toMatch(/z\.array\(\s*z\.object/);
    }

    tsconfigPath = join(REPO_ROOT, `tsconfig.reset-facet-array-acceptance.${process.pid}.json`);
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: {
          noEmit: true,
          incremental: false,
          tsBuildInfoFile: null,
          paths: {
            "@/*": ["./src/*"],
            "@test/*": ["./test/*"],
            "@enricai/barnacle/*": ["./src/*"],
          },
        },
        include: [`src/sites/${siteId}/**/*.ts`],
      })
    );
    const check = spawnSync(TSC_BIN, ["-p", tsconfigPath, "--noEmit"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(check.status, `${check.stdout}\n${check.stderr}\n${contract}`).toBe(0);
  }, 120_000);
});
