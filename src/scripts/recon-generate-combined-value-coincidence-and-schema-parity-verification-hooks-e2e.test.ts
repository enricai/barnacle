import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Composes the three isolated fixtures
 * (recon-generate-primary-capture-frozen-index-value-multi-target-threading-guard-e2e.test.ts,
 * recon-generate-toggle-capture-single-source-multi-target-boolean-threading-guard-e2e.test.ts,
 * recon-generate-1-12-50-payload-field-body-schema-structural-parity-tsc-e2e.test.ts) into
 * ONE contract-generation pass — a hoisted primary-response frozen-index
 * decoy, a per-item fold-loop drill, an auxiliary toggle-capture boolean, and
 * top-level filter fields threaded through submit — matching the report's
 * real shape of multiple simultaneous decoy sources in one contract. Encodes
 * the report's own "Suggested verification hooks": (a) `tsc --noEmit`
 * zero-diagnostic pass on the regenerated contract, and (b) a structural,
 * corpus-agnostic scan proving no emitted field is ever sourced from a
 * differently-named decoy local.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.combined-verification-hooks-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
// Compound-segment path sharing the "item" token with the toggle read below
// — this is what keeps the auxiliary capture out of extractActionSequence's
// structural-isolation exclusion (recon/capture-filters.ts's
// isStructurallyIsolatedCapture) and into actionCaptures, so
// compileActionSteps' name-correlation gate — not an unrelated upstream
// filter — is what this test actually exercises.
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/item-detail-info/`;
const TOGGLES_URL = `https://${OWN_BACKEND_HOST}/toggles/item-avail-flags/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// Genuinely-reused values: same field name threaded on both sides.
const DETAIL_TOKEN_VALUE = "detail-token-item-a";
const STORE_ID_VALUE = "STORE-DISTRIBUTION-CENTER-01";
const REGION_VALUE = "REGION-WEST-DISTRIBUTION-01";
const CURRENCY_VALUE = "CURRENCY-USD-STANDARD-01";

// Decoy 1: a value hoisted via a FIXED index into the PRIMARY (search)
// response, unrelated to either loop item — coincidentally equal to two
// differently-named drill-body fields at once (pagination-like + count-like).
const FROZEN_PRIMARY_INDEX_VALUE = 619;

// Decoy 2: a single auxiliary toggle-capture boolean fanning out into two
// unrelated, differently-named submit-body fields simultaneously.
const SPECIAL_OFFER_TOGGLE_VALUE = true;

function fixtureCaptures(): Capture[] {
  const list = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({
      page: 1,
      storeId: STORE_ID_VALUE,
      region: REGION_VALUE,
      currency: CURRENCY_VALUE,
    }),
    responseBody: {
      results: [{ itemId: "item-a" }, { itemId: "item-b" }],
      // Fixed literal-index map into the primary response, unrelated to
      // either loop item's own object — read once before the fold loop.
      meta: {
        catalogInfo: {
          "3": { tierInfo: { tierInfo: FROZEN_PRIMARY_INDEX_VALUE } },
        },
      },
    },
    timestamp: "2026-01-01T00:00:00Z",
  });
  // Auxiliary out-of-flow capture — not narrated by any recon-flow.json step.
  const toggles = buildCapture({
    url: TOGGLES_URL,
    requestPostData: "[]",
    responseBody: {
      dclSpecialOfferRefactor: SPECIAL_OFFER_TOGGLE_VALUE,
    },
    timestamp: "2026-01-01T00:00:01Z",
  });
  // Only ONE per-item drill call is ever recorded (item-a) — the fold plan
  // must synthesize item-b's from item data. `filters.page` and
  // `filters.adultCount` coincidentally equal the frozen primary decoy.
  const detailA = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      filters: { page: FROZEN_PRIMARY_INDEX_VALUE, adultCount: FROZEN_PRIMARY_INDEX_VALUE },
    }),
    responseBody: { detailToken: DETAIL_TOKEN_VALUE, itemId: "item-a" },
    timestamp: "2026-01-01T00:00:02Z",
  });
  // Submit re-sends the top-level filter fields verbatim, the genuinely
  // reused `detailToken`, and two decoy-shaped fields fanned out from the
  // SAME single toggle-read boolean.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      detailToken: DETAIL_TOKEN_VALUE,
      page: 1,
      storeId: STORE_ID_VALUE,
      region: REGION_VALUE,
      currency: CURRENCY_VALUE,
      accessible: SPECIAL_OFFER_TOGGLE_VALUE,
      pageHistory: SPECIAL_OFFER_TOGGLE_VALUE,
    }),
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:03Z",
  });
  return [list, toggles, detailA, submit];
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

/** Every `payload.<ident>` accessor referenced anywhere in the emitted source. */
function extractPayloadAccessors(contract: string): Set<string> {
  const accessors = new Set<string>();
  for (const match of contract.matchAll(/\bpayload\.([A-Za-z_$][\w$]*)/g)) {
    accessors.add(match[1]!);
  }
  return accessors;
}

/** Every field name declared inside the emitted PayloadSchema's `.extend({...})` block(s). */
function extractSchemaFields(contract: string): Set<string> {
  const fields = new Set<string>();
  for (const extendMatch of contract.matchAll(
    /PayloadSchema\s*=[\s\S]*?\.extend\(\{([\s\S]*?)\n\}\)/g
  )) {
    const body = extendMatch[1]!;
    for (const fieldMatch of body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) {
      fields.add(fieldMatch[1]!);
    }
  }
  return fields;
}

/**
 * Structural name-correlation scan: for a given emitted `"field": ${source}`
 * pair, the field name and the interpolated source's own last identifier
 * segment must share a recognizable token. Rather than special-casing field
 * names, this asserts none of the report's known decoy source tokens
 * (frozen primary-index locals, toggle-capture locals) ever appear as the
 * interpolation source for a differently-named field anywhere in the body.
 */
function assertNoDecoySourceLeaksIntoField(
  bodyTemplate: string,
  fieldName: string,
  decoyTokens: RegExp
): void {
  const fieldLine = bodyTemplate.match(new RegExp(`"${fieldName}"\\s*:\\s*"?\\$\\{([^}]*)\\}"?`));
  if (!fieldLine) return;
  expect(fieldLine[1], `field "${fieldName}" sourced from: ${fieldLine[1]}`).not.toMatch(
    decoyTokens
  );
}

let workDir: string | null = null;
let siteOutDir: string | null = null;
let tsconfigPath: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  if (tsconfigPath) rmSync(tsconfigPath, { force: true });
  workDir = null;
  siteOutDir = null;
  tsconfigPath = null;
});

describe("recon-generate CLI + tsc --noEmit — combined value-coincidence and schema-parity verification hooks", () => {
  it("typechecks clean and never sources an emitted field from a differently-named decoy local, across a single multi-decoy contract", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-combined-verification-hooks-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `combined-verification-hooks-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
          { step: "open item detail panel" },
          { step: "submit item selection", submitStep: true },
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

    // A genuine per-item ancestor for-loop drill — proves the fixture
    // actually exercises the fold/drill-loop path, not a hardcoded per-item
    // call.
    expect(contract).toMatch(/for\s*\(const \w+ of \w+\)/);

    // Non-vacuity: the auxiliary toggle read must have survived into its own
    // emitted httpClient call — otherwise the assertions below would pass
    // trivially because compileActionSteps never even saw its field.
    expect(contract).toMatch(/toggles\/item-avail-flags/);

    // --- Required item (b): full-body name-correlation scan ---

    const drillBodyMatch = contract.match(/catalog\/item-detail-info\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(drillBodyMatch, contract).not.toBeNull();
    const drillBodyTemplate = drillBodyMatch![1]!;

    // Neither the pagination-like nor the count-like drill-body field may be
    // sourced from the frozen, fixed-index primary-response decoy.
    assertNoDecoySourceLeaksIntoField(drillBodyTemplate, "page", /tierinfo|catalogInfo/i);
    assertNoDecoySourceLeaksIntoField(drillBodyTemplate, "adultCount", /tierinfo|catalogInfo/i);
    expect(drillBodyTemplate).not.toMatch(/tierinfo/i);
    expect(drillBodyTemplate).not.toMatch(/catalogInfo/i);

    const submitBodyMatch = contract.match(/catalog\/submit\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(submitBodyMatch, contract).not.toBeNull();
    const submitBodyTemplate = submitBodyMatch![1]!;

    // The toggle-capture's own-named local must never leak into either
    // differently-named decoy target, and the two decoy targets must never
    // resolve to the exact same interpolation source as each other.
    assertNoDecoySourceLeaksIntoField(submitBodyTemplate, "accessible", /special|offer/i);
    assertNoDecoySourceLeaksIntoField(submitBodyTemplate, "pageHistory", /special|offer/i);
    expect(contract).not.toMatch(/\$\{[^}]*dclSpecialOfferRefactor[^}]*\}/i);

    const accessibleLine = submitBodyTemplate.match(/"accessible"\s*:\s*"?([^,\n}]*)"?/);
    const pageHistoryLine = submitBodyTemplate.match(/"pageHistory"\s*:\s*"?([^,\n}]*)"?/);
    if (
      accessibleLine &&
      pageHistoryLine &&
      accessibleLine[1]!.includes("${") &&
      pageHistoryLine[1]!.includes("${")
    ) {
      expect(accessibleLine[1]).not.toBe(pageHistoryLine[1]);
    }

    // Genuinely-reused, name-correlated fields must still resolve.
    const detailTokenLine = submitBodyTemplate.match(/"detailToken"\s*:\s*"?\$\{([^}]*)\}"?/);
    expect(detailTokenLine, submitBodyTemplate).not.toBeNull();
    expect(detailTokenLine![1]).toMatch(/detailtoken/i);

    // No invalidly-nested placeholder anywhere in any emitted body.
    expect(drillBodyTemplate).not.toMatch(/\$\{[^}]*\$\{/);
    expect(submitBodyTemplate).not.toMatch(/\$\{[^}]*\$\{/);

    // Generalized, corpus-agnostic structural parity: every payload.<field>
    // accessor anywhere in the contract must have a matching declared field
    // on the emitted PayloadSchema.
    const accessors = extractPayloadAccessors(contract);
    const schemaFields = extractSchemaFields(contract);
    expect(accessors.size).toBeGreaterThanOrEqual(5);
    const undeclared = [...accessors].filter((name) => !schemaFields.has(name));
    expect(
      undeclared,
      JSON.stringify({ accessors: [...accessors], schemaFields: [...schemaFields] })
    ).toEqual([]);

    // --- Required item (a): tsc --noEmit zero-diagnostic pass ---

    tsconfigPath = join(REPO_ROOT, `tsconfig.combined-verification-hooks.${process.pid}.json`);
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: {
          noEmit: true,
          incremental: false,
          tsBuildInfoFile: null,
          paths: {
            "@/*": ["./src/*"],
            "@test/*": ["./test/*"],
            "@enricai/barnacle/*": ["./src/*"],
          },
        },
        include: [`src/sites/${siteId}/**/*.ts`],
      })
    );

    const check = spawnSync(TSC_BIN, ["-p", tsconfigPath, "--noEmit"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    const diagnostics = `${check.stdout}\n${check.stderr}`;
    const referencesEmittedFiles = diagnostics.includes("contract.ts");
    expect(referencesEmittedFiles, diagnostics).toBe(false);
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
