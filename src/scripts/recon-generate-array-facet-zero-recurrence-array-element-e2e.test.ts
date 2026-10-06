import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Closes the gap left by
 * recon-generate-1-12-75-navigateto-payloadfield-body-threading-e2e.test.ts,
 * whose facet literal still recurs verbatim in a later captured body — the
 * ordinary recurrence-anchored path `harvestPersonaBindings`/
 * `interpolateStateValues` already handles. This fixture's navigateTo hash
 * value (`CATALOG_HASH_TOKEN`) is transformed by the site before the real
 * request — it never appears LITERALLY anywhere in any later capture's URL,
 * headers, or body (the report's zero-recurrence shape), so the field is
 * only reachable via the causally-adjacent-action fallback under test:
 * the real request's own NEW query-string value (`CATEGORY_CODE`, absent
 * from the immediately-preceding action's capture) is what must get spliced
 * into `payload.<Field>`, not the navigateTo literal itself.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-facet-zero-recurrence-element-fixture.example.com";
const HASH_A = "zzq-nonrecurring-hash-a-99";
const HASH_B = "zzq-nonrecurring-hash-b-98";
const CODE_A = "cc-adjacent-9471-code";
const CODE_B = "dd-adjacent-5528-code";

function fixtureCaptures(): Capture[] {
  const body = (filters: unknown[]): string => JSON.stringify({ sort: "relevance", filters });
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: body([]),
      responseBody: { ok: true },
      timestamp: "2026-03-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: body([{ code: CODE_A }]),
      responseBody: { ok: true },
      timestamp: "2026-03-01T00:00:01.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/`,
      requestPostData: body([{ code: CODE_A }, { code: CODE_B }]),
      responseBody: { ok: true },
      timestamp: "2026-03-01T00:00:02.000Z",
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

describe("recon-generate CLI — navigateTo payloadField with zero literal recurrence threads via the causally-adjacent action", () => {
  it("splices the adjacent request's own new query value into payload.<Field> when the navigateTo literal never recurs anywhere", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-facet-zero-recurrence-element-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-facet-zero-recurrence-element-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate with facet a",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${HASH_A}`,
            payloadField: "FacetA",
          },
          {
            step: "navigate with facet b",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${HASH_B}`,
            payloadField: "FacetB",
          },
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

    expect(contract).toContain("payload.FacetA");
    expect(contract).toContain("payload.FacetB");
    expect(contract).not.toContain(CODE_A);
    expect(contract).not.toContain(CODE_B);
    expect(contract).not.toContain(HASH_A);
    expect(contract).not.toContain(HASH_B);

    // Every declared facet must be referenced by the carrying request's body,
    // not left as a payloadField with zero references.
    const filterBlock = contract.slice(contract.indexOf("filter-results"));
    expect(filterBlock).toContain("payload.FacetA");
    expect(filterBlock).toContain("payload.FacetB");

    // The payload schema still declares the field.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    expect(schema).toMatch(/ {2}FacetA:/);
    expect(schema).toMatch(/ {2}FacetB:/);
  }, 30_000);
});
