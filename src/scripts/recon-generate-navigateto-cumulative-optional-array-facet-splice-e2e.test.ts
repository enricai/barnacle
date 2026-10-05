import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Combines recon-generate-navigateto-cumulative-array-element-facet-splice-e2e's
 * cumulative-hash delta extraction (five navigateTo steps, each declaring a
 * distinct payloadField via a comma-accumulating hash, whose five tokens all
 * recur as elements of ONE shared array-typed body field) with
 * recon-generate-navigateto-array-element-optional-facet-splice-e2e's
 * all-optional conditional-splice grammar. Pre-fix, the report's exact
 * untested combination — cumulative-hash extraction plus five facets plus
 * all-optional plus one shared array — is not exercised by either sibling
 * test alone: the cumulative test's facets are all required, and the
 * optional test only covers one optional facet beside one required sibling.
 * Drives the real `recon:generate` CLI end to end and asserts every facet's
 * own `payload.<Field>` accessor, wrapped in its own optional conditional
 * spread, appears inside the shared array field's body text.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST =
  "www.navigateto-cumulative-optional-array-facet-splice-fixture.example.com";
const DELIMITER_SUFFIX = ";src=facet";

// Tokens are chosen so none is a substring of another — the same discipline
// the cumulative-hash test documents — to keep the collision guard
// orthogonal to the fix under test.
const FACETS: ReadonlyArray<{ token: string; field: string }> = [
  { token: "alfa-opt-mkr", field: "CategoryFacet" },
  { token: "bravo-opt-mkr", field: "SubcategoryFacet" },
  { token: "charlie-opt-mkr", field: "ColorFacet" },
  { token: "delta-opt-mkr", field: "SizeFacet" },
  { token: "echo-opt-mkr", field: "FitFacet" },
];

function cumulativeHash(uptoIndex: number): string {
  return FACETS.slice(0, uptoIndex + 1)
    .map((f) => f.token)
    .join(",");
}

function fixtureCaptures(): Capture[] {
  // All five facet tokens recur as elements of ONE shared array field —
  // the report's exact multi-facet reproduction shape — rather than as
  // separate flat keys.
  const selectedFacets = FACETS.map((facet) => `${facet.token}${DELIMITER_SUFFIX}`);
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-03-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/`,
      requestPostData: JSON.stringify({ selectedFacets }),
      responseBody: { ok: true },
      timestamp: "2026-03-01T00:00:01.000Z",
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

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — five all-optional cumulative-hash navigateTo facets sharing one array-typed body field each thread their own conditional accessor", () => {
  it("binds every facet's own token to its own optionally-spliced payload accessor inside the shared array field, never collapsing to one accessor or swallowing the array whole", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-navigateto-cumulative-optional-array-facet-splice-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `navigateto-cumulative-optional-array-facet-splice-test-${process.pid}`;
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
            optional: true,
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

    const bodyBlocks = [...contract.matchAll(/body:\s*`([^`]*)`,/g)].map((m) => m[1] ?? "");
    expect(bodyBlocks.length, contract).toBeGreaterThan(0);
    const combinedBody = bodyBlocks.join("\n");

    const accessorsFound = FACETS.map((facet) => {
      const splice = `...(payload.${facet.field} ? [\`\${payload.${facet.field}}`;
      return { field: facet.field, splice, present: combinedBody.includes(splice) };
    });

    for (const { field, present, splice } of accessorsFound) {
      expect(
        present,
        `expected ${field}'s conditional accessor "${splice}" in: ${combinedBody}`
      ).toBe(true);
    }

    // Each facet must bind to its OWN distinct conditional accessor — the
    // pre-fix bug wholesale-swallowed the shared array into one opaque
    // ${JSON.stringify(payload.selectedFacets)} blob, threading none of the
    // five facets at all.
    const distinctSplices = new Set(accessorsFound.map((a) => a.splice));
    expect(distinctSplices.size).toBe(FACETS.length);

    expect(combinedBody).not.toContain("JSON.stringify(payload.selectedFacets)");

    // An omitted optional facet must never splice the literal string
    // "undefined" into the body.
    expect(contract).not.toContain("undefined");

    // No facet's own captured literal token may survive frozen in a body
    // template — every occurrence must have been rewritten to its accessor.
    for (const facet of FACETS) {
      for (const body of bodyBlocks) {
        expect(body).not.toContain(facet.token);
      }
    }

    // The payload schema still declares every facet field.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    for (const facet of FACETS) {
      expect(schema).toMatch(new RegExp(`\\s{2}${facet.field}: z\\.string\\(\\),`));
    }
  }, 30_000);
});
