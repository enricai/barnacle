import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * End-to-end substitute for the live repro named in the originating report
 * (a `recon:generate` run against a real capture archive that is not present
 * in this environment). Runs the real CLI — which drives emitBrowserFlowTs,
 * emitMultiStepExecuteHttp, and emitContractTs together — against a synthetic
 * catalog/search flow combining a navigateTo-declared scalar facet field
 * (bugfix-001's mechanism) and a top-level array-of-objects field (bugfix-002's
 * mechanism) in the same flow, then asserts generically — over every field the
 * generated schema declares, not just these two — that each one is actually
 * referenced as `payload.<field>` somewhere in the generated code outside its
 * own schema declaration line, and that no field's only reference lives
 * inside a header-only template that never reaches the request body. This
 * guards both fixes' area together against the defect shape the report
 * demonstrated: a field present and required in the schema while being
 * referenced nowhere functional in the generated output.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.declared-fields-genuinely-referenced-regression-fixture.example.com";
const CATEGORY_FRAGMENT = "gadgets";

const QUANTITY_MIX = [
  { typeId: 1, count: 2 },
  { typeId: 2, count: 1 },
];

function fixtureCaptures(): Capture[] {
  // No response field of `search` is reused as a request field of `submit`
  // (e.g. no shared `itemId`), so fold/join correlation never kicks in —
  // every submit-body field must resolve from the payload directly, keeping
  // the fixture isolated to the two mechanisms this test targets.
  const search = buildCapture({
    url: `https://${OWN_BACKEND_HOST}/catalog/search/`,
    requestPostData: JSON.stringify({ sort: "relevance", quantityMix: QUANTITY_MIX }),
    requestHeaders: {
      "Content-Type": "application/json",
      "X-Catalog-Category": CATEGORY_FRAGMENT,
    },
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  const submit = buildCapture({
    url: `https://${OWN_BACKEND_HOST}/catalog/submit/`,
    // Intentionally no key here collides in value with CATEGORY_FRAGMENT —
    // that cross-key-same-value coincidence is already covered by the
    // navigateTo single-mechanism regression sibling; colliding it here
    // would conflate schema-field dedup behavior with the two mechanisms
    // this test isolates.
    requestPostData: JSON.stringify({
      quantityMix: QUANTITY_MIX,
      confirm: true,
    }),
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:01.000Z",
  });
  return [search, submit];
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

describe("recon-generate CLI — every declared schema field is genuinely referenced in generated output", () => {
  it("threads a navigateTo-declared scalar facet and a top-level array field into real payload.<field> references, not just schema declarations", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-declared-fields-genuinely-referenced-regression-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `declared-fields-genuinely-referenced-regression-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the gadgets catalog category page",
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

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // Both facets must actually be declared as schema-required fields.
    expect(contract).toMatch(/ {2}Category:/);
    expect(contract).toMatch(/ {2}quantityMix:/);

    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{([\s\S]*?)\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schemaBody = schemaMatch?.[1] ?? "";

    // Every declared TOP-LEVEL payload field name, excluding genuinely
    // static/internal ones (BaseUrl is a caller-supplied base URL, never
    // sourced from a capture) must be referenced as `payload.<field>`
    // somewhere in the generated code OUTSIDE the schema declaration
    // itself. Tracks paren/brace depth so nested object-field names (e.g.
    // `typeId`/`count` inside quantityMix's own `z.object({...})`) are
    // never mistaken for top-level payload fields.
    const declaredFieldNames: string[] = [];
    let depth = 0;
    for (const line of schemaBody.split("\n")) {
      const fieldMatch = depth === 0 ? /^ {2}(\w+):/.exec(line) : null;
      if (fieldMatch) declaredFieldNames.push(fieldMatch[1]!);
      for (const char of line) {
        if (char === "(" || char === "{") depth += 1;
        if (char === ")" || char === "}") depth -= 1;
      }
    }
    const fieldsToCheck = declaredFieldNames.filter((name) => name !== "BaseUrl");
    expect(fieldsToCheck.length).toBeGreaterThanOrEqual(2);

    const contractWithoutSchemaDeclaration = contract.replace(schemaMatch![0], "");
    for (const field of fieldsToCheck) {
      const payloadAccessorPattern = new RegExp(`payload\\.${field}\\b`);
      expect(
        contractWithoutSchemaDeclaration,
        `declared field "${field}" has no payload.${field} reference outside its schema declaration`
      ).toMatch(payloadAccessorPattern);
    }

    // The array field (bugfix-002's mechanism) is captured as a request-body
    // key, so its genuine reference must land inside a body template, not
    // merely survive somewhere in a non-body-affecting tracking header —
    // proving the reference is load-bearing, not a decoy.
    const bodyTemplates = [...contract.matchAll(/body:\s*`([\s\S]*?)`,\s*\n\s*schema:/g)].map(
      (m) => m[1]!
    );
    expect(bodyTemplates.length, contract).toBeGreaterThanOrEqual(1);
    const allBodies = bodyTemplates.join("\n");
    expect(allBodies).toMatch(/payload\.quantityMix\b/);

    // The navigateTo-declared facet (bugfix-001's mechanism) is captured
    // only as a request header in this fixture, so its genuine reference
    // must land inside a header block — never left as the frozen literal.
    const headerBlocks = [...contract.matchAll(/headers:\s*\{([\s\S]*?)\},/g)].map(
      (m) => m[1] ?? ""
    );
    expect(headerBlocks.some((h) => h.includes("payload.Category"))).toBe(true);
    for (const header of headerBlocks) {
      expect(header).not.toContain(`"${CATEGORY_FRAGMENT}"`);
    }

    // The raw captured array values must never survive frozen as literals
    // in any request body.
    expect(allBodies).not.toMatch(/"typeId"\s*:\s*1/);
    expect(allBodies).not.toMatch(/"typeId"\s*:\s*2/);
  }, 30_000);
});
