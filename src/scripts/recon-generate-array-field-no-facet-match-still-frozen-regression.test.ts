import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Guards against the `payloadAccessorExcludeValues` fix over-firing: an
 * array field whose captured elements never equal any navigateTo-declared
 * facet's literal (ordinary recon-captured data with no facet correlation)
 * must still be wholesale-swallowed into the opaque
 * `${JSON.stringify(payload.<field>)}` form exactly as it was pre-fix. The
 * fixture runs a navigateTo-bound facet on a sibling field in the SAME
 * generation pass as the unrelated array field, so the new exclusion path
 * and the old swallow path are proven to coexist rather than only being
 * exercised in isolation.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-field-no-facet-match-still-frozen-fixture.example.com";
const REGION_FRAGMENT = "north-ridge";

// Two genuinely distinct values for the same top-level array-of-objects
// key, captured on two different steps of the same flow. Neither contains
// REGION_FRAGMENT, so this field has no payload-accessor literal match.
const LINE_ITEMS_STEP_0 = [
  { sku: "SKU-100", quantity: 2 },
  { sku: "SKU-200", quantity: 1 },
];
const LINE_ITEMS_STEP_1 = [
  { sku: "SKU-300", quantity: 5 },
  { sku: "SKU-400", quantity: 3 },
  { sku: "SKU-500", quantity: 1 },
];

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/cart/`,
      requestPostData: JSON.stringify({ lineItems: LINE_ITEMS_STEP_0 }),
      requestHeaders: {
        "Content-Type": "application/json",
        "X-Catalog-Region-Tracking": REGION_FRAGMENT,
      },
      responseBody: { ok: true, index: 0 },
      timestamp: "2026-04-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/checkout/`,
      requestPostData: JSON.stringify({ lineItems: LINE_ITEMS_STEP_1 }),
      responseBody: { ok: true, index: 1 },
      timestamp: "2026-04-01T00:00:01.000Z",
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

describe("recon-generate CLI — array field with no payload-accessor facet match stays wholesale-frozen alongside an unrelated navigateTo facet", () => {
  it("keeps lineItems swallowed as payload.lineItems while RegionFacet still splices from its navigateTo binding", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-field-no-facet-match-still-frozen-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-field-no-facet-match-still-frozen-test-${process.pid}`;
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
          { step: "add to cart" },
          { step: "checkout", submitStep: true },
        ],
        submitEndpointPattern: "catalog/checkout",
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

    // The navigateTo-bound facet still splices into the header — proves
    // the exclusion path fires in this same generation run.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedFacetSplice = "${payload.RegionFacet}";
    const headerBlocks = [...contract.matchAll(/headers:\s*\{([\s\S]*?)\},/g)].map(
      (m) => m[1] ?? ""
    );
    expect(headerBlocks.some((h) => h.includes(expectedFacetSplice))).toBe(true);

    // lineItems — which has no payload-accessor literal match anywhere —
    // is still wholesale-swallowed exactly as before the fix.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedLineItemsSub = "${JSON.stringify(payload.lineItems)}";
    expect(contract).toContain(`"lineItems":${expectedLineItemsSub}`);

    const bodyTemplates = [...contract.matchAll(/body:\s*`([\s\S]*?)`/g)].map((m) => m[1] ?? "");
    expect(bodyTemplates.length).toBeGreaterThan(0);
    for (const body of bodyTemplates) {
      expect(body).not.toContain(JSON.stringify(LINE_ITEMS_STEP_0));
      expect(body).not.toContain(JSON.stringify(LINE_ITEMS_STEP_1));
      expect(body).not.toContain('"sku":"SKU-100"');
      expect(body).not.toContain('"sku":"SKU-300"');
    }

    // PayloadSchema declares lineItems as a required array field.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    const lineItemsFieldMatch = schema.match(/ {2}lineItems:[\s\S]*?\n {2}\S/);
    expect(lineItemsFieldMatch, schema).not.toBeNull();
    const lineItemsField = lineItemsFieldMatch![0]!;
    expect(lineItemsField).toMatch(/z\.array/);
    expect(lineItemsField).not.toMatch(/\.optional\(\)/);
  }, 30_000);
});
