import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the contract that a payload field accessed by index in an emitted
 * body is declared as its structured array type, never a scalar z.string().
 * The short (<8 char) criteria value also appears as a scalar in another
 * body and the field recurs at several call sites, the shapes that
 * historically let a scalar registration win over the structured one.
 * Generic travel-search fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.schema-body-indexed-accessor-parity-fixture.example.com";
const ORIGIN_TOKEN = "origin-hash-sort-facet-6623";
const SOURCE_ID = "slugId";

function fixtureCaptures(): Capture[] {
  const sorts = [
    { criteria: "price", order: "ASC" },
    { criteria: `${ORIGIN_TOKEN};sourceId=${SOURCE_ID}`, order: "DESC" },
  ];
  const at = (path: string, post: unknown, n: number): Capture =>
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/${path}`,
      requestPostData: JSON.stringify(post),
      responseBody: { ok: true },
      timestamp: `2026-05-01T00:00:0${n}.000Z`,
    });
  return [
    at("flights/results/", { sorts }, 0),
    at("flights/refine/", { sorts, sortBy: "price" }, 1),
    at("flights/apply-sort/", { sorts }, 2),
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

describe("recon-generate CLI + tsc --noEmit — array-of-objects field schema/body type consistency", () => {
  it("emits z.array(z.object(...)) for the recurring structured field and typechecks with zero diagnostics", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-schema-body-indexed-accessor-parity-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `schema-body-indexed-accessor-parity-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to search with the origin facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/flights/${ORIGIN_TOKEN}`,
            payloadField: "OriginFacet",
          },
          { step: "browse flights" },
          { step: "apply sort", submitStep: true },
        ],
        submitEndpointPattern: "flights/apply-sort",
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

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    // The emitted schema must declare the recurring structured field as an
    // array of objects, never a bare string fallback.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    expect(schema).toMatch(/sorts:[^\n]*z\.array\(z\.object\(/);
    expect(schema).not.toMatch(/sorts:\s*z\.string\(\)/);

    // Body-construction accessors indexing into sorts as an array
    // (e.g. payload.sorts["0"]!.field) only type-check when the
    // schema agrees it's an array of objects — tsc below is the ultimate
    // arbiter, but this is a quick, readable signal of the same invariant.
    const bodyBlocks = [...contract.matchAll(/body:\s*`([^`]*)`,/g)].map((m) => m[1] ?? "");
    expect(bodyBlocks.length, contract).toBeGreaterThan(0);
    if (/payload\.sorts\["\d+"\]/.test(contract)) {
      expect(schema).not.toMatch(/\bsorts:\s*z\.string\(\)/);
    }

    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.schema-body-indexed-accessor-parity.${process.pid}.json`
    );
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
    const referencesEmittedFiles = diagnostics.includes("contract.ts");
    expect(referencesEmittedFiles, diagnostics).toBe(false);
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
