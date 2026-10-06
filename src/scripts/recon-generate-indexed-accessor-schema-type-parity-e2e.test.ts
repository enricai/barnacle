import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins schema/accessor type parity for an indexed object-array field: the
 * emitted payload schema declares it as z.array(z.object(...)) and the
 * generated contract typechecks under tsc with zero diagnostics. Generic
 * recipe-catalog fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.indexed-accessor-schema-type-parity-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/recipes/results/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/recipes/apply-order/`;
const CUISINE_TOKEN = "cuisine-hash-order-facet-5521";
const SOURCE_ID = "slugId";

function fixtureCaptures(): Capture[] {
  // orderCriteria recurs verbatim across two call sites (≥2 object keys,
  // ≥2 array elements each), and one element carries the navigateTo facet
  // literal suffixed by a constant delimiter — the exact exclusion shape
  // that historically skipped schema registration for the whole field.
  const orderCriteria = [
    { field: "relevance", direction: "desc" },
    { field: `${CUISINE_TOKEN};sourceId=${SOURCE_ID}`, direction: "asc" },
  ];
  const listPage = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ orderCriteria }),
    responseBody: { ok: true },
    timestamp: "2026-05-01T00:00:00.000Z",
  });
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({ orderCriteria }),
    responseBody: { ok: true },
    timestamp: "2026-05-01T00:00:01.000Z",
  });
  return [listPage, submit];
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

    workDir = mkdtempSync(join(tmpdir(), "barnacle-indexed-accessor-schema-type-parity-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `indexed-accessor-schema-type-parity-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to search with the cuisine facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/recipes/${CUISINE_TOKEN}`,
            payloadField: "CuisineFacet",
          },
          { step: "browse recipes" },
          { step: "apply order", submitStep: true },
        ],
        submitEndpointPattern: "recipes/apply-order",
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
    expect(schema).toMatch(/orderCriteria:[^\n]*z\.array\(z\.object\(/);
    expect(schema).not.toMatch(/orderCriteria:\s*z\.string\(\)/);

    expect(contract).not.toMatch(/payload\.orderCriteria\[/);

    // Body-construction accessors indexing into orderCriteria as an array
    // (e.g. payload.orderCriteria["0"]!.field) only type-check when the
    // schema agrees it's an array of objects — tsc below is the ultimate
    // arbiter, but this is a quick, readable signal of the same invariant.
    const bodyBlocks = [...contract.matchAll(/body:\s*`([^`]*)`,/g)].map((m) => m[1] ?? "");
    expect(bodyBlocks.length, contract).toBeGreaterThan(0);

    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.indexed-accessor-schema-type-parity.${process.pid}.json`
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
