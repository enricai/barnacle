import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Locks in the fix in extractNavigateToHashFragmentValue/harvestPersonaBindings
 * (recon-generate.ts) for a multi-step, comma-accumulating navigateTo hash —
 * the report's exact reproduction shape, where each step's hash is a superset
 * of the prior step's. Pre-fix, every step after the first bound the whole
 * cumulative hash string instead of only its own new token, so distinct
 * facets collapsed onto the same (or a frozen) value. This drives the real
 * `recon:generate` CLI end to end and asserts each facet's own
 * `payload.<Field>` accessor appears in the generated request BODY template,
 * each one distinct from every other facet's accessor.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.navigateto-partial-facet-resolution-fixture.example.com";

// Tokens are chosen so none is a substring of another; collisions are
// covered by the scalar-facet-collision test, and keeping them out here
// isolates the hash-delta behavior under test.
const FACETS: ReadonlyArray<{ token: string; field: string }> = [
  { token: "alfa-mkr", field: "CategoryFacet" },
  { token: "bravo-mkr", field: "SubcategoryFacet" },
  { token: "charlie-mkr", field: "ColorFacet" },
  { token: "delta-mkr", field: "SizeFacet" },
  { token: "echo-mkr", field: "FitFacet" },
  { token: "foxtrot-mkr", field: "BrandFacet" },
];
const ABSENT_FIELDS = ["FitFacet"];

function cumulativeHash(uptoIndex: number): string {
  return FACETS.slice(0, uptoIndex + 1)
    .map((f) => f.token)
    .join(",");
}

function fixtureCaptures(): Capture[] {
  // Body keys deliberately do NOT equal the facet field names: this forces
  // the generated accessor to come from harvestPersonaBindings' VALUE-based
  // persona binding (the exact mechanism the fix touches), not from the
  // separate generic key-name payload substitution, which would trivially
  // satisfy this assertion regardless of whether the hash-delta fix is
  // present.
  const filterBody: Record<string, string> = {};
  for (const facet of FACETS.filter((f) => !ABSENT_FIELDS.includes(f.field)))
    filterBody[`slot${facet.token.replace(/-mkr$/, "")}`] = facet.token;
  const noise = ["alpha", "beta", "gamma"].map((name, i) =>
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/noise-${name}/`,
      requestPostData: JSON.stringify({ unrelated: `noise-value-${name}` }),
      responseBody: { ok: true },
      timestamp: `2026-02-01T00:00:0${i + 2}.000Z`,
    })
  );
  return [
    ...noise,
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-02-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/`,
      requestPostData: JSON.stringify(filterBody),
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

let workDir: string | null = null;
let siteOutDir: string | null = null;

describe("recon-generate CLI — 5+ declared navigateTo facets amid noisy captures: every evidenced facet binds, an unevidenced one is absent", () => {
  it("binds each facet whose literal appears in a captured request to its own accessor and leaves the never-captured facet unbound", () => {
    try {
      workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-partial-facet-resolution-"));
      const runRoot = join(workDir, "run");
      writeRunDir(runRoot, fixtureCaptures());

      const siteId = `navigateto-partial-facet-resolution-test-${process.pid}`;
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

      const bodyBlocks = [...contract.matchAll(/body:\s*`([^`]*)`,/g)].map((m) => m[1] ?? "");
      expect(bodyBlocks.length, contract).toBeGreaterThan(0);
      const combinedBody = bodyBlocks.join("\n");

      const accessorsFound = FACETS.map((facet) => {
        const splice = `\${payload.${facet.field}}`;
        return { field: facet.field, splice, present: combinedBody.includes(splice) };
      });

      for (const { field, present } of accessorsFound) {
        if (ABSENT_FIELDS.includes(field)) continue;
        expect(present, `expected ${field}'s accessor in: ${combinedBody}`).toBe(true);
      }
      for (const field of ABSENT_FIELDS) {
        expect(combinedBody).not.toContain(`\${payload.${field}}`);
      }

      // Each facet must bind to its OWN distinct accessor — the pre-fix bug
      // collapsed every step after the first onto the cumulative hash string,
      // which would either fail to match any single facet's captured literal
      // or (if it happened to match) bind multiple facets to the same value.
      const distinctSplices = new Set(accessorsFound.filter((a) => a.present).map((a) => a.splice));
      expect(distinctSplices.size).toBe(FACETS.length - ABSENT_FIELDS.length);

      // No facet's own captured literal token may survive frozen in a body
      // template — every occurrence must have been rewritten to its accessor.
      for (const facet of FACETS.filter((f) => !ABSENT_FIELDS.includes(f.field))) {
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
