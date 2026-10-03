import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression test for `computeFlowPayloadFieldNames` discarding a navigateTo
 * step's explicit `payloadField` annotation before `resolveStepPayloadField`'s
 * own `explicit` short-circuit could ever honor it. A generic catalog-site
 * flow navigates to a category page whose URL hash names the category
 * (`#/catalog/widgets`), with `payloadField: "Category"` declared explicitly
 * on that step. A downstream request header carries the same category text
 * ("widgets") the navigation URL's hash fragment named. The generated plugin
 * must splice that header value to `${payload.Category}` instead of freezing
 * it as the recon's captured literal, and must declare `Category` on the
 * payload schema.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.navigateto-facet-field-regression-fixture.example.com";
const CATEGORY_FRAGMENT = "widgets";

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/search/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      requestHeaders: {
        "Content-Type": "application/json",
        "X-Catalog-Category": CATEGORY_FRAGMENT,
      },
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/submit/`,
      requestPostData: JSON.stringify({ category: CATEGORY_FRAGMENT, confirm: true }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:01.000Z",
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

describe("recon-generate CLI — navigateTo step's explicit payloadField reaches emitted headers/body and schema", () => {
  it("splices the header carrying the URL-hash-named category into ${payload.Category} and declares the schema field", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-facet-field-regression-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `navigateto-facet-field-regression-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the widgets catalog category page",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${CATEGORY_FRAGMENT}`,
            payloadField: "Category",
          },
          { step: "browse catalog search" },
          { step: "submit catalog search", submitStep: true },
        ],
        submitEndpointPattern: "catalog/submit",
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
    const expectedSplice = "${payload.Category}";
    expect(contract).toContain(expectedSplice);

    // The recon's captured literal must never survive frozen in any header
    // or body template — every occurrence must have been rewritten.
    const literalFrozenAsJsonValue = `"${CATEGORY_FRAGMENT}"`;
    const headerBlocks = [...contract.matchAll(/headers:\s*\{([\s\S]*?)\},/g)].map(
      (m) => m[1] ?? ""
    );
    expect(headerBlocks.some((h) => h.includes(expectedSplice))).toBe(true);
    for (const header of headerBlocks) {
      expect(header).not.toContain(literalFrozenAsJsonValue);
    }

    // The payload schema declares Category as a payload field.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    expect(schema).toMatch(/ {2}Category:/);
  }, 30_000);
});
