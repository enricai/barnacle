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

const OWN_BACKEND_HOST = "www.navigateto-zero-recurrence-adjacent-action-fixture.example.com";
const CATALOG_HASH_TOKEN = "zzq-nonrecurring-hash-token-99";
const CATEGORY_CODE = "cc-adjacent-9471-code";

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-03-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/?categoryCode=${CATEGORY_CODE}`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
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

describe("recon-generate CLI — navigateTo payloadField with zero literal recurrence threads via the causally-adjacent action", () => {
  it("splices the adjacent request's own new query value into payload.<Field> when the navigateTo literal never recurs anywhere", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-zero-recurrence-adjacent-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `navigateto-zero-recurrence-adjacent-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the catalog with the category facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${CATALOG_HASH_TOKEN}`,
            payloadField: "CategoryFacet",
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

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedSplice = "${payload.CategoryFacet}";

    // The navigateTo literal itself never recurs anywhere in the capture, so
    // the ordinary recurrence-anchored path has nothing to bind — only the
    // adjacent-action fallback under test can produce this splice.
    expect(contract).not.toContain(CATALOG_HASH_TOKEN);
    expect(contract).toContain(expectedSplice);

    // The captured adjacent-action literal that carried the real wire value
    // must not survive frozen — it was the thing spliced.
    expect(contract).not.toContain(CATEGORY_CODE);

    // The payload schema still declares the field.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    expect(schema).toMatch(/ {2}CategoryFacet:/);
  }, 30_000);
});
