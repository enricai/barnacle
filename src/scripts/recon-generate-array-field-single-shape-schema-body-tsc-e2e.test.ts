import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that a key the bodies index as `payload.ordering["0"]!.criteria` has ONE
 * shape (array of objects) on PayloadSchema even when a navigateTo facet value
 * coincides with a leaf inside it, and that the emitted contract typechecks.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-field-single-shape-fixture.example.com";
const DELIMITER = ";kind=slug";
const CATEGORY_TOKEN = "categoryx-retail-7001";
const SITE_PATHS = ["/shop/query-a/", "/shop/query-b/", "/shop/query-c/"];

function tagged(token: string): string {
  return `${token}${DELIMITER}`;
}

function fixtureCaptures(): Capture[] {
  const category = tagged(CATEGORY_TOKEN);
  const ordering = [
    { criteria: "price", order: "ASC", region: "MI" },
    { criteria: category, order: "ASC", region: "MI" },
  ];
  const bodies: unknown[] = [
    { ordering, tags: [category, `a${DELIMITER}`] },
    { ordering, tags: [`b${DELIMITER}`, category], page: 1 },
    { ordering, page: 2 },
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

describe("recon-generate CLI + tsc — array-of-object field has one shape across schema and body", () => {
  it("declares an indexed array-of-objects key as z.array(z.object) despite scalar sources naming it, and typechecks clean", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-field-single-shape-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-field-single-shape-tsc-test-${process.pid}`;
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
          { step: "browse shop" },
          { step: "query shop", submitStep: true },
        ],
        submitEndpointPattern: "shop/query-c",
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

    const indexed = [...contract.matchAll(/payload\.(\w+)\["\d+"\]!\.\w+/g)].map((m) => m[1] ?? "");
    const ordering = schemaFieldText(contract, "ordering");
    expect(ordering, contract).toMatch(/z\.array\(\s*z\.object/);
    expect(ordering, ordering).not.toMatch(/z\.string\(\)/);
    expect(contract).not.toMatch(/payload\.ordering(?!\[)/);
    for (const field of new Set(indexed)) {
      const decl = schemaFieldText(contract, field);
      expect(decl, `${field} indexed in body but not declared:\n${contract}`).not.toBe("");
      expect(decl, `${field} declared as scalar:\n${decl}`).not.toMatch(/z\.string\(\)/);
      expect(decl, decl).toMatch(/z\.array\(\s*z\.object/);
    }

    tsconfigPath = join(REPO_ROOT, `tsconfig.array-field-single-shape.${process.pid}.json`);
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
    const diagnostics = `${check.stdout}\n${check.stderr}\n${contract}`;
    expect(check.status, diagnostics).toBe(0);
  }, 120_000);
});
