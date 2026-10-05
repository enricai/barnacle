import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that an array-of-objects request field (`sorts` of `{key, order}` in
 * a generic catalog-search domain) accessed by index in emitted body code is
 * declared `z.array(z.object(...))` on the contract, never `z.string()`, and
 * that the generated plugin typechecks with tsc.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.sorts-array-accessor-schema-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/search/results/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/search/apply-sort/`;
const DESTINATION_HASH_TOKEN = "dest-hash-sort-facet-4412";
const SOURCE_ID = "urlFriendlyId";

function fixtureCaptures(): Capture[] {
  // sorts recurs verbatim across two call sites (≥2 object keys,
  // ≥2 array elements each), and one element carries the navigateTo facet
  // literal suffixed by a constant delimiter — the exact exclusion shape
  // that historically skipped schema registration for the whole field.
  const sorts = [
    { key: "popularity", order: "desc" },
    { key: `${DESTINATION_HASH_TOKEN};sourceId=${SOURCE_ID}`, order: "asc" },
  ];
  const listPage = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ sorts }),
    responseBody: { ok: true },
    timestamp: "2026-04-01T00:00:00.000Z",
  });
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({ sorts }),
    responseBody: { ok: true },
    timestamp: "2026-04-01T00:00:01.000Z",
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

    workDir = mkdtempSync(join(tmpdir(), "barnacle-sorts-array-accessor-schema-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `sorts-array-accessor-schema-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to search with the destination facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/search/${DESTINATION_HASH_TOKEN}`,
            payloadField: "DestinationFacet",
          },
          { step: "browse search results" },
          { step: "apply sort order", submitStep: true },
        ],
        submitEndpointPattern: "search/apply-sort",
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

    tsconfigPath = join(REPO_ROOT, `tsconfig.sorts-array-accessor-schema.${process.pid}.json`);
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
