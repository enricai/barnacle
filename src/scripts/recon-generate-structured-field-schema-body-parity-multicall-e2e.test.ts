import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Reproduction for schema/body parity: a payload field's declared Zod type
 * must be derived from every way the emitted body code accesses it. The
 * fixture is a generic catalog-search domain where one structured
 * array-of-objects field (`sortCriteria`) recurs by value across several
 * call sites, alongside a facet-owned string array, a body that carries the
 * same literal as a scalar, and an envelope-wrapped call site.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const HOST = "www.structured-field-parity-fixture.example.com";
const FACET_TOKEN = "category-hash-sort-facet-5521";
const SORT_VALUE = "price-ascending-sort-key";

const SORT_CRITERIA = [
  { criteria: SORT_VALUE, order: "ASC" },
  { criteria: "rating-descending-sort-key", order: "DESC" },
  { criteria: `${FACET_TOKEN};scope=catalog`, order: "ASC" },
];
const CATEGORY_IDS = [FACET_TOKEN, "category-other-9917"];

function fixtureCaptures(): Capture[] {
  const at = (n: number): string => `2026-04-01T00:00:0${n}.000Z`;
  return [
    buildCapture({
      url: `https://${HOST}/catalog/search/`,
      requestPostData: JSON.stringify({
        sortCriteria: SORT_CRITERIA,
        categoryIds: CATEGORY_IDS,
        pageSize: 20,
      }),
      responseBody: { ok: true },
      timestamp: at(0),
    }),
    buildCapture({
      url: `https://${HOST}/catalog/facets/`,
      requestPostData: JSON.stringify({ sortCriteria: SORT_CRITERIA, categoryIds: CATEGORY_IDS }),
      responseBody: { ok: true },
      timestamp: at(1),
    }),
    buildCapture({
      url: `https://${HOST}/catalog/preview/`,
      requestPostData: JSON.stringify({ sortKey: SORT_VALUE, categoryIds: CATEGORY_IDS }),
      responseBody: { ok: true },
      timestamp: at(2),
    }),
    buildCapture({
      url: `https://${HOST}/catalog/summary/`,
      requestPostData: JSON.stringify({ sortCriteria: SORT_VALUE, categoryIds: CATEGORY_IDS }),
      responseBody: { ok: true },
      timestamp: at(4),
    }),
    buildCapture({
      url: `https://${HOST}/catalog/apply-sort/`,
      requestPostData: JSON.stringify({
        request: { sortCriteria: SORT_CRITERIA, categoryIds: CATEGORY_IDS },
      }),
      responseBody: { ok: true },
      timestamp: at(3),
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
let tsconfigPath: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  if (tsconfigPath) rmSync(tsconfigPath, { force: true });
  workDir = null;
  siteOutDir = null;
  tsconfigPath = null;
});

describe("recon-generate CLI + tsc --noEmit — structured field schema/body parity across several call sites", () => {
  it("declares the indexed-accessor field as an array of objects and typechecks cleanly", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-structured-field-parity-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `structured-field-parity-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to search with the category facet applied",
            navigateTo: `https://${HOST}/#/search/${FACET_TOKEN}`,
            payloadField: "CategoryFacet",
          },
          { step: "browse search results" },
          { step: "apply sort order", submitStep: true },
        ],
        submitEndpointPattern: "catalog/apply-sort",
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

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    const declaredSortCriteria = [...contract.matchAll(/^\s*sortCriteria:\s*([^\n]*)$/gm)].map(
      (m) => m[1] ?? ""
    );
    expect(declaredSortCriteria.length, contract).toBeGreaterThan(0);
    for (const declared of declaredSortCriteria) {
      expect(declared).toMatch(/z\.array\(z\.object\(/);
    }

    tsconfigPath = join(REPO_ROOT, `tsconfig.structured-field-parity.${process.pid}.json`);
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
  }, 60_000);
});
