import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression test for `computeFlowPayloadFieldNames` deriving a declared
 * `payloadField`'s schema optionality from the originating step's
 * execution-skip `optional` flag. A step marked `optional: true` (meaning it
 * may fail/skip during execution) that also declares an explicit
 * `payloadField` must still produce a REQUIRED schema field — the author
 * explicitly named the facet, so the schema contract must reflect that
 * regardless of whether the browser step itself is allowed to skip.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.payloadfield-optional-step-required-schema-fixture.example.com";
const CATEGORY_FRAGMENT = "widgets";
const FACET_FRAGMENT = "clearance";

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/search/`,
      requestPostData: JSON.stringify({ sort: "relevance", facet: FACET_FRAGMENT }),
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

function schemaFieldLine(contract: string, field: string): string {
  const schemaMatch = contract.match(
    /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
  );
  expect(schemaMatch, contract).not.toBeNull();
  const schema = schemaMatch?.[0] ?? "";
  const lineMatch = schema.match(new RegExp(`^ {2}${field}:.*$`, "m"));
  expect(lineMatch, schema).not.toBeNull();
  return lineMatch?.[0] ?? "";
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — explicit payloadField stays required even when its step is optional", () => {
  it("declares a REQUIRED schema field for a navigateTo step's explicit payloadField despite optional: true", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-payloadfield-optional-step-regression-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `payloadfield-optional-step-regression-test-${process.pid}`;
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
            optional: true,
          },
          { step: `select the ${FACET_FRAGMENT} facet`, payloadField: "Facet", optional: true },
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

    const categoryLine = schemaFieldLine(contract, "Category");
    expect(categoryLine).not.toContain(".optional()");

    const facetLine = schemaFieldLine(contract, "Facet");
    expect(facetLine).not.toContain(".optional()");
  }, 30_000);
});
