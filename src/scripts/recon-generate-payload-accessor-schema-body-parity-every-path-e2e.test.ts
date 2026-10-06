import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins schema/body parity across every registration path: a `sorts` field of
 * `{key, order}` read by index, re-queried with different bodies and nested
 * in a wrapper, stays an array-of-objects in the payload schema, no accessor
 * field is z.string(), and the emitted contract typechecks with tsc.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.accessor-schema-body-parity-every-path-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/search/results/`;
const NESTED_URL = `https://${OWN_BACKEND_HOST}/search/nested/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/search/apply-sort/`;
const DESTINATION_HASH_TOKEN = "dest-hash-sort-facet-4412";
const SOURCE_ID = "urlFriendlyId";

function fixtureCaptures(): Capture[] {
  // The first body reads sorts by index; later call sites re-query it with
  // different bodies, and a nested wrapper carries the same field, so no
  // single body/registration order may decide the schema type.
  const sorts = [
    { key: "popularity", order: "desc" },
    { key: `${DESTINATION_HASH_TOKEN};sourceId=${SOURCE_ID}`, order: "asc" },
  ];
  const otherSorts = [
    { key: "title", order: "asc" },
    { key: "published", order: "desc" },
  ];
  const listPage = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ sorts, page: 1 }),
    responseBody: { ok: true },
    timestamp: "2026-04-01T00:00:00.000Z",
  });
  const requery = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ sorts: otherSorts, page: 2 }),
    responseBody: { ok: true },
    timestamp: "2026-04-01T00:00:01.000Z",
  });
  const nested = buildCapture({
    url: NESTED_URL,
    requestPostData: JSON.stringify({ query: { sorts, filter: "all" } }),
    responseBody: { ok: true },
    timestamp: "2026-04-01T00:00:02.000Z",
  });
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({ sorts }),
    responseBody: { ok: true },
    timestamp: "2026-04-01T00:00:03.000Z",
  });
  return [listPage, requery, nested, submit];
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

    workDir = mkdtempSync(join(tmpdir(), "barnacle-accessor-schema-body-parity-every-path-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `accessor-schema-body-parity-every-path-test-${process.pid}`;
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

    const accessorFields = new Set(
      [...contract.matchAll(/payload\.(\w+)\[/g)].map((m) => m[1] ?? "")
    );
    for (const field of accessorFields) {
      expect(schema, `${field} indexed in a body`).not.toMatch(
        new RegExp(`\\b${field}:\\s*z\\.string\\(\\)`)
      );
    }

    // Body-construction accessors indexing into sorts as an array
    // (e.g. payload.sorts["0"]!.field) only type-check when the
    // schema agrees it's an array of objects — tsc below is the ultimate
    // arbiter, but this is a quick, readable signal of the same invariant.
    const bodyBlocks = [...contract.matchAll(/body:\s*`([^`]*)`,/g)].map((m) => m[1] ?? "");
    expect(bodyBlocks.length, contract).toBeGreaterThan(0);

    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.accessor-schema-body-parity-every-path.${process.pid}.json`
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
