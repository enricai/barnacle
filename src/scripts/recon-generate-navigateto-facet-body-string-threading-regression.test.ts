import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Closes the B2 coverage gap: a navigateTo+payloadField step's bound facet
 * value is already proven to splice into a tracking HEADER
 * (recon-generate.navigateto-explicit-payloadfield-facet-regression.test.ts)
 * and into a body where it is its own top-level key
 * (recon-generate-1-12-75-navigateto-payloadfield-body-threading-e2e.test.ts),
 * but neither proves the shape the report's own fields exhibited: the SAME
 * navigateTo-sourced value recurring, on a LATER request, packed inside a
 * delimited facet-filter string under a DIFFERENT wire key (not an exact
 * top-level `field: value` match). This drives the real `recon:generate` CLI
 * over a flow where the value appears both in an early header and later
 * embedded in such a string, asserting both occurrences are spliced.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.navigateto-facet-body-string-threading-fixture.example.com";
const REGION_FRAGMENT = "north-ridge";

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      requestHeaders: {
        "Content-Type": "application/json",
        "X-Catalog-Region-Tracking": REGION_FRAGMENT,
      },
      responseBody: { ok: true },
      timestamp: "2026-03-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/`,
      requestPostData: JSON.stringify({
        variables: { sku: "sku-a", filters: `region:${REGION_FRAGMENT}|category:widgets` },
      }),
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

describe("recon-generate CLI — navigateTo-sourced facet threads into a differently-keyed body facet string, not just headers", () => {
  it("splices the navigateTo-bound region value into the payload.RegionFacet accessor in both the tracking header and the later delimited filters string", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-facet-body-string-threading-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `navigateto-facet-body-string-threading-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the north ridge region catalog page",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/region/${REGION_FRAGMENT}`,
            payloadField: "RegionFacet",
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
    const expectedSplice = "${payload.RegionFacet}";

    // Spliced into the early tracking header (the already-proven shape).
    const headerBlocks = [...contract.matchAll(/headers:\s*\{([\s\S]*?)\},/g)].map(
      (m) => m[1] ?? ""
    );
    expect(headerBlocks.some((h) => h.includes(expectedSplice))).toBe(true);

    // Spliced into the LATER call's differently-keyed delimited facet
    // string too — the exact shape the report's own fields exhibited, and
    // the one no prior regression test exercises for a navigateTo-sourced
    // binding.
    const bodyBlocks = [...contract.matchAll(/body:\s*`([^`]*)`,/g)].map((m) => m[1] ?? "");
    expect(bodyBlocks.length, contract).toBeGreaterThan(0);
    const combinedBody = bodyBlocks.join("\n");
    expect(combinedBody).toMatch(/region:\$\{payload\.RegionFacet\}/);
    expect(combinedBody).toContain("category:widgets");

    // The captured literal must never survive frozen anywhere in the
    // emitted headers or body templates.
    for (const header of headerBlocks) {
      expect(header).not.toContain(REGION_FRAGMENT);
    }
    for (const body of bodyBlocks) {
      expect(body).not.toContain(REGION_FRAGMENT);
    }

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(combinedBody).not.toMatch(/\$\{[^}]*\$\{/);

    // The payload schema declares RegionFacet as a payload field.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    expect(schema).toMatch(/ {2}RegionFacet:/);
  }, 30_000);
});
