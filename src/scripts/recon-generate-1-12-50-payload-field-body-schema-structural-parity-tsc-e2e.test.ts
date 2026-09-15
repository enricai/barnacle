import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Generalizes the named-field spot checks in
 * recon-generate-1-12-50-payload-schema-body-field-parity-tsc-e2e.test.ts
 * into a corpus-agnostic structural invariant: every `payload.<field>`
 * accessor appearing anywhere in an emitted contract.ts's URL/header/body
 * templates must have a matching declared field on the emitted
 * PayloadSchema. Drives the real CLI over a multi-field ancestor for-loop
 * drill corpus shaped like the report (page/exploreMorePage/storeId/region/
 * currency), then extracts both sets purely via regex rather than asserting
 * on any individually named field, and separately pins zero-diagnostic
 * `tsc -p` on the emitted site, matching the report's own suggested
 * verification hook (a).
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.payload-field-body-schema-structural-parity-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// Each value is long enough to clear recon-generate's MIN_STATE_VALUE_LENGTH
// (8), so every one is a candidate for splicing as a payload accessor
// rather than staying a frozen literal.
const STORE_ID_VALUE = "STORE-DISTRIBUTION-CENTER-01";
const REGION_VALUE = "REGION-WEST-DISTRIBUTION-01";
const CURRENCY_VALUE = "CURRENCY-USD-STANDARD-01";
const EXPLORE_MORE_PAGE_VALUE = "EXPLORE-MORE-PAGE-TOKEN-01";

function fixtureCaptures(): Capture[] {
  // The ancestor list call: its own body carries page/storeId/region/
  // currency, each re-sent verbatim by the per-item submit call below.
  const listPage = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({
      page: EXPLORE_MORE_PAGE_VALUE,
      storeId: STORE_ID_VALUE,
      region: REGION_VALUE,
      currency: CURRENCY_VALUE,
    }),
    responseBody: {
      totalPages: 1,
      results: [{ itemId: "item-a" }, { itemId: "item-b" }, { itemId: "item-c" }],
    },
    timestamp: "2026-05-01T00:00:00Z",
  });
  // Per-item detail drill — an ancestor for-loop over the list's own array,
  // not a hardcoded per-item call. Each carries its own distinct
  // exploreMorePage token re-sent verbatim by the submit below.
  const detailA = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      exploreMorePage: EXPLORE_MORE_PAGE_VALUE,
    }),
    responseBody: { storeCode: "store-42" },
    timestamp: "2026-05-01T00:00:01Z",
  });
  const detailB = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({
      itemId: "item-b",
      exploreMorePage: EXPLORE_MORE_PAGE_VALUE,
    }),
    responseBody: { storeCode: "store-43" },
    timestamp: "2026-05-01T00:00:02Z",
  });
  const detailC = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({
      itemId: "item-c",
      exploreMorePage: EXPLORE_MORE_PAGE_VALUE,
    }),
    responseBody: { storeCode: "store-44" },
    timestamp: "2026-05-01T00:00:03Z",
  });
  // Re-sends every ancestor field verbatim — the report's shape: several
  // distinct, differently-named submit-body fields threaded simultaneously
  // through the same ancestor drill loop.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      page: EXPLORE_MORE_PAGE_VALUE,
      storeId: STORE_ID_VALUE,
      region: REGION_VALUE,
      currency: CURRENCY_VALUE,
    }),
    responseBody: { ok: true },
    timestamp: "2026-05-01T00:00:04Z",
  });
  return [listPage, detailA, detailB, detailC, submit];
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
let tsconfigPath: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  if (tsconfigPath) rmSync(tsconfigPath, { force: true });
  workDir = null;
  siteOutDir = null;
  tsconfigPath = null;
});

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

describe("recon-generate CLI + tsc --noEmit — generalized payload.<field> body/schema structural parity", () => {
  it("declares every payload.<field> body/header/URL accessor on PayloadSchema for a multi-field ancestor-drill corpus and typechecks clean", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-payload-field-body-schema-structural-parity-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `payload-field-body-schema-structural-parity-e2e-test${process.pid}`;
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

    // A genuine ancestor for-loop drill, not a hardcoded per-item call.
    expect(contract).toMatch(/for\s*\(const \w+ of \w+\)/);

    const accessors = extractPayloadAccessors(contract);
    const schemaFields = extractSchemaFields(contract);

    // The corpus is shaped to thread 5+ distinct fields — a trivial/empty
    // extraction would silently pass an inclusion check with nothing to check.
    expect(accessors.size).toBeGreaterThanOrEqual(5);

    const undeclared = [...accessors].filter((name) => !schemaFields.has(name));
    expect(
      undeclared,
      JSON.stringify({ accessors: [...accessors], schemaFields: [...schemaFields] })
    ).toEqual([]);

    // The full corpus's emitted plugin must typecheck with zero diagnostics
    // — the report's other defect (schema/body-emission disagreement).
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.payload-field-body-schema-structural-parity.${process.pid}.json`
    );
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
