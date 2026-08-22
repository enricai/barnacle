import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";

/**
 * Regression guard for the filed report: recon-generate must derive a
 * ResponseSchema that tolerates cosmetic server-response drift (recurring
 * `__typename`, presentational leaf fields that come and go across
 * repeated hits of the same operation) without gutting its ability to
 * reject a response missing a genuinely load-bearing field.
 *
 * Exercises the real CLI (`tsx recon-generate.ts`), matching
 * recon-generate-response-schema-replay-stability.test.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PRIMARY_URL = "https://www.catalog-fixture.example.com/graph";

function gqlCapture(overrides: { phase: string; responseBody: unknown }) {
  return {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: overrides.phase,
    method: "POST",
    url: PRIMARY_URL,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: "{}",
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: "catalogListing",
    query: "query catalogListing { items { id __typename title badge label } }",
    variables: null,
    decodedParams: null,
  };
}

/** A catalog item shaped like the reported drift class: a deeply nested
 * per-item object carrying `__typename` plus a couple of presentational
 * leaf fields, repeated across list entries. */
function catalogItem(overrides: {
  id: string;
  badge?: string;
  label?: string;
}): Record<string, unknown> {
  return {
    __typename: "CatalogItem",
    id: overrides.id,
    title: `widget ${overrides.id}`,
    ...(overrides.badge !== undefined ? { badge: overrides.badge } : {}),
    ...(overrides.label !== undefined ? { label: overrides.label } : {}),
  };
}

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  // The operation is re-hit more than once in the run, with slightly
  // varying per-item field presence across hits -- exactly the shape
  // inferZodSchemaFromSamples needs to fold optional presentational
  // fields instead of pinning them as required.
  const firstHit = gqlCapture({
    phase: "browse-the-catalog-page-1",
    responseBody: {
      __typename: "Query",
      items: [
        catalogItem({ id: "1", badge: "new", label: "featured" }),
        catalogItem({ id: "2", badge: "sale" }),
      ],
    },
  });
  const secondHit = gqlCapture({
    phase: "browse-the-catalog-page-2",
    responseBody: {
      __typename: "Query",
      items: [catalogItem({ id: "3", label: "featured" })],
    },
  });

  writeFileSync(
    join(root, "graphql", "000-browse-the-catalog-page-1-action.json"),
    JSON.stringify(firstHit)
  );
  writeFileSync(
    join(root, "graphql", "001-browse-the-catalog-page-2-action.json"),
    JSON.stringify(secondHit)
  );
}

function extractResponseSchemaLine(contract: string): string {
  const match = contract.match(
    /^export const \w+ResponseSchema = ([\s\S]+?);\n\nexport type \w+Response = /m
  );
  if (!match?.[1]) throw new Error(`no ResponseSchema declaration found in contract:\n${contract}`);
  return match[1];
}

function runGenerate(runRoot: string, siteId: string): string {
  const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate ResponseSchema: tolerates cosmetic drift without gutting real-breakage detection", () => {
  it("accepts a live sample with dropped/added presentational leaves but rejects one missing a load-bearing field", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-response-schema-drift-tolerance-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `response-schema-drift-tolerance-test-p${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    const contract = runGenerate(runRoot, siteId);
    const schemaExpr = extractResponseSchemaLine(contract);
    const ResponseSchema: z.ZodTypeAny = new Function("z", `return ${schemaExpr};`)(z);

    // Cosmetic drift: the reported over-rejection case. `badge` is dropped,
    // an entirely unrecognized new leaf `promoTag` is added, `__typename`
    // keeps recurring. This must now validate successfully.
    const driftedSample = {
      __typename: "Query",
      items: [
        {
          __typename: "CatalogItem",
          id: "4",
          title: "widget 4",
          label: "featured",
          promoTag: "clearance",
        },
      ],
    };
    expect(ResponseSchema.safeParse(driftedSample).success).toBe(true);

    // Real breakage: the load-bearing top-level `items` field -- present in
    // every captured sample and therefore required -- is missing entirely.
    // This must still be rejected.
    const brokenSample = { __typename: "Query" };
    expect(ResponseSchema.safeParse(brokenSample).success).toBe(false);
  }, 30_000);
});
