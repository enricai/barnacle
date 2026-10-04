import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression for the mis-pairing gap in the zero-recurrence navigateTo
 * fallback added for
 * recon-generate-1-12-76-navigateto-zero-recurrence-adjacent-action-fallback-e2e.test.ts.
 * That fallback used to pair declared facets with newly-appearing request
 * values by flat position (`candidateValues[index]`). When an intervening
 * action's capture introduces a THIRD newly-appearing value that has nothing
 * to do with either facet (here: a rotating session token echoed back on
 * every request after it's minted), the flat pairing shifts: the first facet
 * still binds correctly, but the second facet silently binds to the
 * intervening session token instead of its own real value — a wrong-but-
 * plausible splice with no compile/lint signal.
 *
 * This fixture has two zero-recurrence navigateTo+payloadField facets
 * (`DepartmentFacet`, `RegionFacet`) and an intervening action between their
 * real values that introduces an unrelated new query value
 * (`sessionToken`). With the fix, the correlation pool has three
 * single-value transitions for only two facets — an unresolvable mismatch —
 * so NEITHER facet is bound via the fallback, rather than one of them being
 * bound to the wrong literal.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.navigateto-ambiguous-adjacency-fixture.example.com";
const DEPARTMENT_HASH_TOKEN = "dpt-nonrecurring-hash-77";
const REGION_HASH_TOKEN = "rgn-nonrecurring-hash-88";
const DEPARTMENT_CODE = "dept-code-3301";
const SESSION_TOKEN = "sess-tok-unrelated-6624";
const REGION_CODE = "region-code-9912";

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-03-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/by-department/?departmentCode=${DEPARTMENT_CODE}`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-03-01T00:00:01.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/refresh-session/?sessionToken=${SESSION_TOKEN}`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-03-01T00:00:02.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/?regionCode=${REGION_CODE}`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-03-01T00:00:03.000Z",
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

describe("recon-generate CLI — zero-recurrence navigateTo facets never bind to an unrelated intervening value", () => {
  it("leaves both facets unbound via the fallback rather than mis-pairing one to the intervening session token", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-ambiguous-adjacency-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `navigateto-ambiguous-adjacency-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the catalog with the department facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${DEPARTMENT_HASH_TOKEN}`,
            payloadField: "DepartmentFacet",
          },
          { step: "browse catalog" },
          {
            step: "navigate to the catalog with the region facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${REGION_HASH_TOKEN}`,
            payloadField: "RegionFacet",
          },
          { step: "apply filters", submitStep: true },
        ],
        submitEndpointPattern: "catalog/",
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

    // The regression under test: RegionFacet must never be spliced in place
    // of the unrelated session token — the bug this fixture pins would bind
    // RegionFacet to SESSION_TOKEN's request site instead of REGION_CODE's.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(contract).not.toContain("${payload.RegionFacet}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(contract).not.toContain("${payload.DepartmentFacet}");

    // Neither candidate literal was spliced away: with the ambiguous pool
    // (3 single-value transitions for 2 facets) the fallback must decline to
    // bind anything, so every captured literal survives frozen verbatim.
    expect(contract).toContain(DEPARTMENT_CODE);
    expect(contract).toContain(SESSION_TOKEN);
    expect(contract).toContain(REGION_CODE);

    // Both declared fields still appear in the payload schema — declaring a
    // field always reserves its schema slot regardless of whether this
    // fallback could safely bind it to a real request site.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    expect(schema).toMatch(/ {2}DepartmentFacet:/);
    expect(schema).toMatch(/ {2}RegionFacet:/);
  }, 30_000);
});
