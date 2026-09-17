import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's defect 1 at the CLI/tsc boundary (required item (a):
 * "recon:generate --force output must pass pnpm run typecheck with zero
 * errors"). The entry action's own request body carries a field
 * (`warehouseRegion`) that a later submit call re-sends verbatim, so the
 * body-emission pass splices it as `${payload.warehouseRegion}` — but unless
 * that field is also registered into the discovered-fields set the inferred
 * `PayloadSchema` consumes, the emitted contract.ts references a payload
 * property the schema never declares (TS2339). Models the harness on
 * recon-generate-tsc-clean-emit-e2e.test.ts: drive the real CLI end to end,
 * then run the project's own `tsc -p` against a throwaway tsconfig scoped to
 * the emitted site, asserting zero diagnostics.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.payload-schema-body-field-parity-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// Re-sent verbatim by the submit call below — long enough to clear
// MIN_STATE_VALUE_LENGTH (8), so it is a candidate for splicing rather than
// staying a frozen literal.
const REGION_VALUE = "REGION-WEST-DISTRIBUTION-01";

function fixtureCaptures(): Capture[] {
  const listPage1 = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ warehouseRegion: REGION_VALUE, resultPage: 1 }),
    responseBody: { totalPages: 2, results: [{ itemId: "item-a" }] },
    timestamp: "2026-02-01T00:00:00Z",
  });
  const listPage2 = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ warehouseRegion: REGION_VALUE, resultPage: 2 }),
    responseBody: { totalPages: 2, results: [{ itemId: "item-b" }] },
    timestamp: "2026-02-01T00:00:01Z",
  });
  const detail = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-a" }),
    responseBody: { storeCode: "store-42" },
    timestamp: "2026-02-01T00:00:02Z",
  });
  // Re-sends the entry action's own `warehouseRegion` value verbatim — the
  // exact condition that must produce a `${payload.warehouseRegion}` splice
  // AND a matching schema declaration.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      warehouseRegion: REGION_VALUE,
    }),
    responseBody: { ok: true },
    timestamp: "2026-02-01T00:00:03Z",
  });
  return [listPage1, listPage2, detail, submit];
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

const REFINE_A_URL = `https://${OWN_BACKEND_HOST}/catalog/refine-a/`;
const REFINE_B_URL = `https://${OWN_BACKEND_HOST}/catalog/refine-b/`;

// A deeply-nested, unrelated numeric leaf on the drill loop's per-item
// detail response. Kept under recon-generate's MIN_STATE_VALUE_LENGTH (8) so
// the only way it could thread into the submit body is via the length-floor
// bypass that requires field-name correlation.
const SORT_ORDER_VALUE = 5;
// The submit body's own, differently-named field that coincidentally shares
// the SAME value as the unrelated nested leaf above.
const PRIORITY_RANK_VALUE = SORT_ORDER_VALUE;

// Same key ("region"), two DIFFERENT literal values, each on its own
// non-entry step — the report's defect 1 shape (bugfix-001): dedupe-by-key
// alone would only ever register the FIRST-scanned occurrence, leaving the
// other step's own literal frozen instead of a declared payload accessor.
const REGION_A_VALUE = "east";
const REGION_B_VALUE = "west";

function combinedFixtureCaptures(): Capture[] {
  const listPage1 = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ warehouseRegion: REGION_VALUE, resultPage: 1 }),
    responseBody: {
      totalPages: 1,
      results: [{ itemId: "item-a" }, { itemId: "item-b" }],
    },
    timestamp: "2026-03-01T00:00:00Z",
  });
  // The ancestor-drill loop's per-item detail call: its own response carries
  // a deeply-nested scalar that coincidentally equals a later, differently-
  // named submit-body field's true value.
  const detailA = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-a" }),
    responseBody: {
      storeCode: "store-42",
      meta: { ranking: { display: { sortOrder: SORT_ORDER_VALUE } } },
    },
    timestamp: "2026-03-01T00:00:01Z",
  });
  const detailB = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-b" }),
    responseBody: {
      storeCode: "store-43",
      meta: { ranking: { display: { sortOrder: 99 } } },
    },
    timestamp: "2026-03-01T00:00:02Z",
  });
  // Two non-entry steps reusing the SAME field name under DIFFERENT literal
  // values — every occurrence must independently resolve to `${payload.region}`.
  const refineA = buildCapture({
    url: REFINE_A_URL,
    requestPostData: JSON.stringify({ region: REGION_A_VALUE }),
    responseBody: { ok: true },
    timestamp: "2026-03-01T00:00:03Z",
  });
  const refineB = buildCapture({
    url: REFINE_B_URL,
    requestPostData: JSON.stringify({ region: REGION_B_VALUE }),
    responseBody: { ok: true },
    timestamp: "2026-03-01T00:00:04Z",
  });
  // Re-sends the entry action's own `warehouseRegion` verbatim, plus the
  // coincidence-shaped field (must never bind to the unrelated `sortOrder`
  // leaf) and the second refine step's own `region` literal.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      warehouseRegion: REGION_VALUE,
      priorityRank: PRIORITY_RANK_VALUE,
      region: REGION_B_VALUE,
    }),
    responseBody: { ok: true },
    timestamp: "2026-03-01T00:00:05Z",
  });
  return [listPage1, detailA, detailB, refineA, refineB, submit];
}

describe("recon-generate CLI + tsc --noEmit — combined multi-defect corpus (bugfix-001 + bugfix-002 + bugfix-003 composed on one generation pass)", () => {
  it("emits a contract.ts that typechecks clean AND sources every collision-shaped body field from its own name-correlated accessor", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-combined-multi-defect-corpus-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, combinedFixtureCaptures());

    const siteId = `combined-multi-defect-corpus-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
          { step: "open item detail panel" },
          { step: "select refine filter A" },
          { step: "select refine filter B" },
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

    // The ancestor-drill loop over the listing's own array is genuine, not a
    // hardcoded per-item call.
    expect(contract).toMatch(/\.results;\n\s*await Promise\.allSettled\(\n\s*\(\w+\)\.map\(async \(\w+\) => \{/);

    // The reused-key-with-different-literal-value fields must both resolve
    // to their own name-correlated payload accessor, not stay frozen.
    const refineOccurrences = contract.match(/"region":"\$\{payload\.region\}"/g) ?? [];
    expect(refineOccurrences.length).toBeGreaterThanOrEqual(2);
    expect(contract).not.toMatch(new RegExp(`"region":"${REGION_A_VALUE}"`));
    expect(contract).not.toMatch(new RegExp(`"region":"${REGION_B_VALUE}"`));

    // Isolate the submit call's request-body template literal.
    const bodyLineMatch = contract.match(/catalog\/submit\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(bodyLineMatch, contract).not.toBeNull();
    const bodyTemplate = bodyLineMatch![1]!;

    // The entry action's own re-sent field must splice via its own
    // name-correlated accessor.
    const warehouseRegionLine = bodyTemplate.match(/"warehouseRegion"\s*:\s*"?\$\{([^}]*)\}"?/);
    expect(warehouseRegionLine, bodyTemplate).not.toBeNull();
    expect(warehouseRegionLine![1]).toMatch(/warehouseRegion/i);

    // The coincidence-shaped field must never bind to the unrelated,
    // deeply-nested `sortOrder` local it merely happens to equal in value.
    const priorityRankLine = bodyTemplate.match(/"priorityRank"\s*:\s*"?([^,\n}]*)"?/);
    if (priorityRankLine && priorityRankLine[1]!.includes("${")) {
      expect(priorityRankLine[1]).not.toMatch(/sortOrder/i);
    }

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(bodyTemplate).not.toMatch(/\$\{[^}]*\$\{/);

    // The full corpus's emitted plugin must typecheck with zero diagnostics
    // — the report's other defect (schema/body-emission disagreement).
    tsconfigPath = join(REPO_ROOT, `tsconfig.combined-multi-defect-corpus.${process.pid}.json`);
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

describe("recon-generate CLI + tsc --noEmit — emitted body-field payload accessors stay declared on PayloadSchema", () => {
  it("emits a contract.ts whose payload.<field> body references and PayloadSchema shape agree under tsc", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-payload-schema-body-field-parity-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `payload-schema-body-field-parity-e2e-test${process.pid}`;
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
    expect(existsSync(contractPath)).toBe(true);

    // Uniquely named and removed in `afterEach`, matching
    // recon-generate-tsc-clean-emit-e2e.test.ts's own throwaway-tsconfig
    // pattern. Emitted plugins import their engine dependencies through the
    // bare `@enricai/barnacle/*` specifier (the out-of-tree operator's own
    // installed package) — this repo IS that package, and its subpaths
    // mirror `src/*` 1:1, so a `paths` override resolves the emitted imports
    // against source without a dist build.
    tsconfigPath = join(REPO_ROOT, `tsconfig.payload-schema-body-field-parity.${process.pid}.json`);
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
