import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins schema/accessor parity for an array-of-objects `sorts` field that
 * appears at several call sites: one with a facet-recurring element, one
 * whose body lacks the field, and one where an element value recurs as a
 * scalar. The emitted schema must stay an array of objects and the contract
 * must typecheck. Generic retail catalog fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-field-schema-body-agreement-all-sites-fixture.example.com";
const SITE_PATHS = ["/shop/list/", "/shop/browse/", "/shop/search/"];
const CATEGORY_TOKEN = "categoryx-retail-9001";
const SOURCE_ID = "urlFriendlyId";

function fixtureCaptures(): Capture[] {
  const bodies: unknown[] = [
    {
      sorts: [
        { criteria: "price", order: "ASC", region: "MI" },
        { criteria: `${CATEGORY_TOKEN};sourceId=${SOURCE_ID}`, order: "DESC", region: "MI" },
      ],
    },
    { page: 1 },
    {
      sorts: [{ criteria: "rating", order: "ASC", region: "OH" }],
      sortKey: "price",
    },
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

describe("recon-generate CLI + tsc --noEmit — array field schema/body agreement at all call sites", () => {
  it("keeps sorts an array of objects and typechecks with zero diagnostics", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-field-agreement-all-sites-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-field-agreement-all-sites-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the shop with the category facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/shop/category/${CATEGORY_TOKEN}`,
            payloadField: "CategoryFacet",
          },
          { step: "browse shop" },
          { step: "search shop", submitStep: true },
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
    expect(contract).toMatch(/sorts:[^\n]*z\.array\(z\.object\(/);
    expect(contract).not.toMatch(/sorts:\s*z\.string\(\)/);
    expect(contract).not.toContain(CATEGORY_TOKEN);
    expect(contract).not.toMatch(/payload\.sorts\["0"\]!/);

    tsconfigPath = join(REPO_ROOT, `tsconfig.array-field-agreement-all-sites.${process.pid}.json`);
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
