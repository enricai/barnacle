import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Covers required-item 1's "other genuinely varying body fields like
 * groupMix" clause: a top-level captured key whose value is an array of
 * objects (structurally like the reported `groupMix`) must be declared on
 * PayloadSchema and spliced as a `payload.<field>`-driven expression, not
 * frozen as a recon-time literal, when its CONTENT genuinely differs across
 * the run's own captures (not merely its item shape, which
 * recon-generate-array-facet-payload-threading-e2e.test.ts already covers).
 * Distinct from that sibling test, this fixture gives the field two
 * DIFFERENT values across two captures, so the fix cannot pass by
 * special-casing a single fixed literal.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-object-toplevel-facet-discovery-fixture.example.com";

// Two genuinely distinct values for the same top-level array-of-objects
// key, captured on two different steps of the same flow.
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
  const urls = [
    `https://${OWN_BACKEND_HOST}/catalog/cart/`,
    `https://${OWN_BACKEND_HOST}/catalog/checkout/`,
  ];
  const bodies = [LINE_ITEMS_STEP_0, LINE_ITEMS_STEP_1];
  return urls.map((url, index) =>
    buildCapture({
      url,
      requestPostData: JSON.stringify({ lineItems: bodies[index] }),
      responseBody: { ok: true, index },
      timestamp: `2026-02-01T00:00:0${index}.000Z`,
    })
  );
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

describe("recon-generate CLI — top-level array-of-objects field with genuinely varying content across captures", () => {
  it("declares lineItems on PayloadSchema as an array field and splices payload.lineItems instead of freezing either captured literal", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-object-toplevel-facet-discovery-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-object-toplevel-facet-discovery-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "add to cart" }, { step: "checkout", submitStep: true }],
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

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedSub = "${JSON.stringify(payload.lineItems)}";
    expect(contract).toContain(`"lineItems":${expectedSub}`);

    // Neither of the two distinct captured literals may survive frozen in
    // any body template — the fix must make the field a live accessor, not
    // special-case whichever literal was captured first (or last).
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
