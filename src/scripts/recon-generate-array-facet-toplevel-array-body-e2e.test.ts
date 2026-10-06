import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Acceptance pin for a top-level-array request body (no wrapping field) with a
 * non-default facet suffix: every declared facet must splice as
 * `payload.<field>` at every call site, with no by-index accessor left and a
 * clean typecheck. Generic retail catalog fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-facet-toplevel-array-fixture.example.com";
const DELIMITER = ";brandId=slug";
const CATEGORY_TOKEN = "categoryx-retail-9001";
const SHIP_TOKEN = "shipx-retail-9002";
const SITE_PATHS = ["/shop/search-a/", "/shop/search-b/", "/shop/search-c/", "/shop/search-d/"];

function tagged(token: string): string {
  return `${token}${DELIMITER}`;
}

function fixtureCaptures(): Capture[] {
  const category = tagged(CATEGORY_TOKEN);
  const ship = tagged(SHIP_TOKEN);
  const bodies: unknown[] = [
    ["a;brandId=slug", category, "b;brandId=slug"],
    ["a;brandId=slug", category, ship],
    [ship, "c;brandId=slug", category, "d;brandId=slug"],
    [category, ship],
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
 * Splits on the emitter's stable `httpClient(...)` / `schema:` idiom because
 * bodies can contain nested backtick template expressions.
 */
function extractCallSiteBodies(contract: string): Map<string, string> {
  const bodies = new Map<string, string>();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: matching against emitted source text, not a template.
  const chunks = contract.split("httpClient(`${payload.BaseUrl}").slice(1);
  for (const chunk of chunks) {
    const url = chunk.slice(0, chunk.indexOf("`,"));
    const bodyStart = chunk.indexOf("body: `") + "body: `".length;
    const bodyEnd = chunk.indexOf("`,\n      schema:");
    bodies.set(url, chunk.slice(bodyStart, bodyEnd));
  }
  return bodies;
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

describe("recon-generate CLI + tsc --noEmit — top-level-array bodies", () => {
  it("typechecks clean and splices every facet in top-level-array bodies", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-facet-toplevel-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-facet-toplevel-parity-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    const base = `https://${OWN_BACKEND_HOST}/#/shop`;
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the shop with the category facet applied",
            navigateTo: `${base}/category/${CATEGORY_TOKEN}`,
            payloadField: "CategoryFacet",
          },
          {
            step: "navigate to the shop with the shipping facet applied",
            navigateTo: `${base}/category/${CATEGORY_TOKEN}/ship/${SHIP_TOKEN}`,
            payloadField: "ShipFacet",
            optional: true,
          },
          { step: "browse shop" },
          { step: "search shop", submitStep: true },
        ],
        submitEndpointPattern: "shop/search-d",
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

    for (const token of [CATEGORY_TOKEN, SHIP_TOKEN]) {
      expect(contract).not.toContain(token);
    }
    expect(contract).not.toMatch(/payload\.\w+\[/);

    const shipSites = SITE_PATHS.slice(1);
    for (const path of SITE_PATHS) {
      const body = bodies.get(path);
      expect(body, contract).toBeDefined();
      expect(body).toContain("payload.CategoryFacet");
      if (shipSites.includes(path)) expect(body).toContain("payload.ShipFacet");
    }

    tsconfigPath = join(REPO_ROOT, `tsconfig.array-facet-multi-site.${process.pid}.json`);
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
    const diagnostics = `${check.stdout}\n${check.stderr}`;
    expect(diagnostics.includes("contract.ts"), diagnostics).toBe(false);
    expect(check.status, diagnostics).toBe(0);
  }, 90_000);
});
