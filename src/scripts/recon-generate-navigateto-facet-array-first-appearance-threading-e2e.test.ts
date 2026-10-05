import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Covers the multi-action-recurrence variant of the array-element facet
 * splice chokepoint that the single-later-action e2e tests
 * (recon-generate-navigateto-array-element-facet-splice-e2e,
 * recon-generate-navigateto-cumulative-array-element-facet-splice-e2e) do
 * not exercise: two navigateTo-declared facets, each via a
 * comma-accumulating hash, whose tokens recur as elements of ONE shared
 * array-typed body field starting on the SAME request where that array
 * first appears (no later-action diff is what introduces the tokens), and
 * the array then stays byte-for-byte unchanged across two further action
 * captures. Pre-fix, applyStructuredValuePayloadSubstitutionsForEnvelope
 * would wholesale-swallow the shared array into one opaque
 * `${JSON.stringify(payload.<field>)}` blob before the splice pass ever
 * got a chance to thread either facet.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.navigateto-facet-array-first-appearance-fixture.example.com";
const DELIMITER_SUFFIX = ";src=listing";

const FACETS: ReadonlyArray<{ token: string; field: string }> = [
  { token: "alfa-lst", field: "CatalogFacet" },
  { token: "bravo-lst", field: "SubcatalogFacet" },
];

function cumulativeHash(uptoIndex: number): string {
  return FACETS.slice(0, uptoIndex + 1)
    .map((f) => f.token)
    .join(",");
}

function sharedArrayField(): string[] {
  return FACETS.map((facet) => `${facet.token}${DELIMITER_SUFFIX}`);
}

function fixtureCaptures(): Capture[] {
  const selectedFacets = sharedArrayField();
  return [
    // No shared array field yet — establishes that the array's very first
    // appearance (below) is on the SAME request as the facet tokens
    // themselves, not introduced by a later-action diff off this capture.
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-05-01T00:00:00.000Z",
    }),
    // The shared array field appears here for the FIRST time, carrying both
    // facet tokens on the very same request.
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/listing-results/`,
      requestPostData: JSON.stringify({ sort: "relevance", selectedFacets, page: 1 }),
      responseBody: { ok: true, page: 1 },
      timestamp: "2026-05-01T00:00:01.000Z",
    }),
    // Two further action captures where the array field recurs byte-for-byte
    // unchanged — the multi-action-recurrence shape this subtask covers.
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/listing-results/`,
      requestPostData: JSON.stringify({ sort: "relevance", selectedFacets, page: 2 }),
      responseBody: { ok: true, page: 2 },
      timestamp: "2026-05-01T00:00:02.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/listing-results/`,
      requestPostData: JSON.stringify({ sort: "relevance", selectedFacets, page: 3 }),
      responseBody: { ok: true, page: 3 },
      timestamp: "2026-05-01T00:00:03.000Z",
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

describe("recon-generate CLI — navigateTo facets thread on first appearance inside a shared array field that recurs unchanged", () => {
  it("splices every facet's own payload.<Field> accessor into the array-carrying body text instead of freezing the array wholesale", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-facet-array-first-appearance-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `navigateto-facet-array-first-appearance-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          ...FACETS.map((facet, index) => ({
            step: `navigate to the listing with the ${facet.field} facet applied`,
            navigateTo: `https://${OWN_BACKEND_HOST}/#${cumulativeHash(index)}`,
            payloadField: facet.field,
            optional: true,
          })),
          { step: "browse catalog" },
          { step: "load listing page 1" },
          { step: "load listing page 2" },
          { step: "load listing page 3", submitStep: true },
        ],
        submitEndpointPattern: "catalog/listing-results",
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

    // The optional facets' splices are nested inside the array's own
    // template-literal interpolation (`${JSON.stringify([...])}` wrapping
    // `${payload.<Field>}` per element), so asserting against the full
    // emitted source — not a single-backtick `body:` regex capture, which
    // would truncate at the array splice's own nested backtick — is what
    // the existing optional-facet array-splice e2e test does too.
    for (const facet of FACETS) {
      const splice = `\${payload.${facet.field}}`;
      expect(contract.includes(splice), `expected ${facet.field}'s accessor in: ${contract}`).toBe(
        true
      );
    }

    // Each facet must bind to its OWN distinct accessor — the array was never
    // swallowed wholesale into one opaque `${JSON.stringify(payload.selectedFacets)}`
    // blob, which would thread none of the facets at all.
    expect(contract).not.toContain("JSON.stringify(payload.selectedFacets)");

    // No facet's raw captured token may survive frozen in the emitted source.
    for (const facet of FACETS) {
      expect(contract).not.toContain(facet.token);
    }
  }, 30_000);
});
