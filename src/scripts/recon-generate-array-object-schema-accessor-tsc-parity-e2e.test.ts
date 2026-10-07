import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that a field the emitted body indexes as `payload.sorts["0"]!.key` is
 * declared as an array of objects even when other schema registration sources
 * (a facet value, a sibling scalar occurrence under the same key) see it as a
 * scalar, and that tsc accepts the emitted file. Generic catalog-search shape.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-object-schema-accessor-parity-fixture.example.com";
const DELIMITER = ";kind=slug";
const FACET_TOKEN = "facetx-catalog-7001";
const SITE_PATHS = ["/catalog/query-a/", "/catalog/query-b/", "/catalog/query-c/"];

function fixtureCaptures(): Capture[] {
  const facet = `${FACET_TOKEN}${DELIMITER}`;
  const sorts = [
    { key: "popularity", order: "desc" },
    { key: facet, order: "asc" },
  ];
  const bodies: unknown[] = [
    { sorts, tags: [facet, `a${DELIMITER}`] },
    { sorts, sortsLabel: facet, page: 1 },
    { sorts, page: 2 },
  ];
  return bodies.map((body, index) =>
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}${SITE_PATHS[index]}`,
      requestPostData: JSON.stringify(body),
      responseBody: { ok: true },
      timestamp: `2026-07-01T00:00:0${index}.000Z`,
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

describe("recon-generate CLI + tsc — array-of-objects field type admits indexed accessors", () => {
  it("declares the indexed field as z.array(z.object) despite scalar sightings elsewhere, and typechecks clean", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-object-accessor-parity-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-object-accessor-parity-tsc-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    const base = `https://${OWN_BACKEND_HOST}/#/catalog`;
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the catalog with the facet applied",
            navigateTo: `${base}/facet/${FACET_TOKEN}`,
            payloadField: "CatalogFacet",
          },
          { step: "browse catalog" },
          { step: "query catalog", submitStep: true },
        ],
        submitEndpointPattern: "catalog/query-c",
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
    expect(indexed, contract).toContain("sorts");
    const sorts = schemaFieldText(contract, "sorts");
    expect(sorts, contract).toMatch(/z\.array\(\s*z\.object/);
    expect(sorts, sorts).not.toMatch(/z\.string\(\)/);
    expect(contract).not.toMatch(/payload\.sorts(?!\[)/);
    for (const field of new Set(indexed)) {
      const decl = schemaFieldText(contract, field);
      expect(decl, `${field} indexed in body but not declared:\n${contract}`).not.toBe("");
      expect(decl, `${field} declared as scalar:\n${decl}`).not.toMatch(/z\.string\(\)/);
      expect(decl, decl).toMatch(/z\.array\(\s*z\.object/);
    }

    tsconfigPath = join(REPO_ROOT, `tsconfig.array-object-accessor-parity.${process.pid}.json`);
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
