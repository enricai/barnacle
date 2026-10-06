import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Extends recon-generate-1-12-76-navigateto-cumulative-hash-facet-threading-e2e's
 * single-array-of-flat-keys shape to the report's literal reproduction: five
 * navigateTo steps each declaring a distinct payloadField via a
 * comma-accumulating hash, whose five extracted tokens all recur — each
 * suffixed by the same constant delimiter — as separate ELEMENTS of ONE
 * shared array-typed body field on a later action. Pre-fix,
 * applyStructuredValuePayloadSubstitutions wholesale-swallowed that whole
 * array into an opaque `${JSON.stringify(payload.<key>)}` blob before the
 * substring-splice pass for any individual facet accessor got a chance to
 * run, so none of the five facets ever threaded. This drives the real
 * `recon:generate` CLI end to end and asserts every facet's own
 * `payload.<Field>` accessor appears inside the shared array field's body
 * text, each one distinct from the others.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.navigateto-cumulative-array-facet-splice-fixture.example.com";
const DELIMITER_SUFFIX = ";src=facet";

// Tokens are chosen so none is a substring of another — the same discipline
// the cumulative-hash test documents — to keep the collision guard
// orthogonal to the fix under test.
const FACETS: ReadonlyArray<{ token: string; field: string }> = [
  { token: "alfa-mkr", field: "CategoryFacet" },
  { token: "bravo-mkr", field: "SubcategoryFacet" },
  { token: "charlie-mkr", field: "ColorFacet" },
  { token: "delta-mkr", field: "SizeFacet" },
  { token: "echo-mkr", field: "FitFacet" },
];

function cumulativeHash(uptoIndex: number): string {
  return FACETS.slice(0, uptoIndex + 1)
    .map((f) => f.token)
    .join(",");
}

function fixtureCaptures(): Capture[] {
  // All five facet tokens recur as elements of ONE shared array field —
  // the report's exact multi-facet reproduction shape — rather than as
  // separate flat keys (which the existing cumulative-hash test already
  // covers).
  const selectedFacets = FACETS.map((facet) => `${facet.token}${DELIMITER_SUFFIX}`);
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-02-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/`,
      requestPostData: JSON.stringify({ selectedFacets }),
      responseBody: { ok: true },
      timestamp: "2026-02-01T00:00:01.000Z",
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

/**
 * Body template of every `httpClient(...)` call. Split on the emitter's stable
 * idiom rather than a backtick-free regex, because a spliced array renders as
 * `${JSON.stringify([`${payload.X}...`])}` and nests backticks.
 */
function extractBodyBlocks(contract: string): string[] {
  return contract
    .split("httpClient(`")
    .slice(1)
    .map((chunk) => chunk.slice(chunk.indexOf("body: `") + "body: `".length))
    .map((chunk) => chunk.slice(0, chunk.indexOf("`,\n      schema:")));
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

describe("recon-generate CLI — five navigateTo facets sharing one array-typed body field each thread their own accessor", () => {
  it("binds every facet's own token to its own payload accessor inside the shared array field, never collapsing to one accessor or swallowing the array whole", () => {
    try {
      workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-cumulative-array-facet-splice-"));
      const runRoot = join(workDir, "run");
      writeRunDir(runRoot, fixtureCaptures());

      const siteId = `navigateto-cumulative-array-facet-splice-test-${process.pid}`;
      siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
      mkdirSync(siteOutDir, { recursive: true });
      writeFileSync(
        join(siteOutDir, "recon-flow.json"),
        JSON.stringify({
          steps: [
            ...FACETS.map((facet, index) => ({
              step: `navigate to the catalog with the ${facet.field} facet applied`,
              navigateTo: `https://${OWN_BACKEND_HOST}/#${cumulativeHash(index)}`,
              payloadField: facet.field,
            })),
            { step: "browse catalog" },
            { step: "apply filters", submitStep: true },
          ],
          submitEndpointPattern: "catalog/filter-results",
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

      const bodyBlocks = extractBodyBlocks(contract);
      expect(bodyBlocks.length, contract).toBeGreaterThan(0);
      const combinedBody = bodyBlocks.join("\n");

      const accessorsFound = FACETS.map((facet) => {
        const splice = `\${payload.${facet.field}}`;
        return { field: facet.field, splice, present: combinedBody.includes(splice) };
      });

      for (const { field, present } of accessorsFound) {
        expect(present, `expected ${field}'s accessor in: ${combinedBody}`).toBe(true);
      }

      // Each facet must bind to its OWN distinct accessor — the pre-fix bug
      // wholesale-swallowed the shared array into one opaque
      // ${JSON.stringify(payload.selectedFacets)} blob, threading none of
      // the five facets at all.
      const distinctSplices = new Set(accessorsFound.map((a) => a.splice));
      expect(distinctSplices.size).toBe(FACETS.length);

      expect(combinedBody).not.toContain("JSON.stringify(payload.selectedFacets)");

      // No facet's own captured literal token may survive frozen in a body
      // template — every occurrence must have been rewritten to its accessor.
      for (const facet of FACETS) {
        for (const body of bodyBlocks) {
          expect(body).not.toContain(facet.token);
        }
      }
    } finally {
      if (workDir) rmSync(workDir, { recursive: true, force: true });
      if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
      workDir = null;
      siteOutDir = null;
    }
  }, 30_000);
});
