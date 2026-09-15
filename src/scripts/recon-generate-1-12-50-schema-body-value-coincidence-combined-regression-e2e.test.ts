import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Combined regression pinning the report's exact failure shape in one
 * fixture: a fold/drill-loop (a listing endpoint whose response array is
 * folded per-item against a detail endpoint) whose per-item detail response
 * plants THREE deeply-nested, distinctly-typed unrelated scalars (a string, a
 * number, a boolean) that each coincidentally equal a later, differently-
 * named submit-body field's true value, alongside a genuinely re-sent entry-
 * body field that must round-trip through `payload.<field>` discovery. Two
 * verification hooks mirror the report exactly: (a) the emitted contract.ts
 * must typecheck with zero diagnostics against the discovered PayloadSchema,
 * and (b) a structural scan of the emitted body must find no field spliced
 * from an unrelated, name-uncorrelated local merely because the values
 * coincide.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST =
  "www.schema-body-value-coincidence-combined-regression-fixture.example.com";
const LISTING_URL = `https://${OWN_BACKEND_HOST}/catalog/listing/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/select/`;

// The entry body's own top-level field — must round-trip via schema-field
// discovery into `payload.warehouseRegion`, exercising the report's other
// verification hook (payload/schema parity).
const WAREHOUSE_REGION_VALUE = "WAREHOUSE-EAST-04";

// Three deeply-nested, distinctly-typed unrelated leaves on the fold/drill
// loop's FIRST per-item detail response. Kept under recon-generate's
// MIN_STATE_VALUE_LENGTH (8) so the only way any of them could thread at all
// is via the length-floor bypass that requires field-name correlation.
const SORT_ORDER_VALUE = 6;
const REGION_CODE_VALUE = "eu9";
const IS_FEATURED_VALUE = true;

// The submit body's own, differently-named fields that coincidentally share
// the SAME values as the three unrelated nested leaves above.
const PRIORITY_RANK_VALUE = SORT_ORDER_VALUE;
const BRANCH_TAG_VALUE = REGION_CODE_VALUE;
const IS_PROMOTED_VALUE = IS_FEATURED_VALUE;

function fixtureCaptures(): Capture[] {
  const listing = buildCapture({
    url: LISTING_URL,
    requestPostData: JSON.stringify({ warehouseRegion: WAREHOUSE_REGION_VALUE, page: 1 }),
    responseBody: {
      page: 1,
      items: [
        {
          itemId: "item-a",
          meta: {
            ranking: { display: { sortOrder: SORT_ORDER_VALUE } },
            location: { facility: { regionCode: REGION_CODE_VALUE } },
            promo: { badges: { isFeatured: IS_FEATURED_VALUE } },
          },
        },
        {
          itemId: "item-b",
          meta: {
            ranking: { display: { sortOrder: 21 } },
            location: { facility: { regionCode: "us3" } },
            promo: { badges: { isFeatured: false } },
          },
        },
      ],
    },
    timestamp: "2026-01-01T00:00:00Z",
  });

  // The fold/drill-loop's per-item detail call.
  const detail = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-a" }),
    responseBody: { itemId: "item-a", title: "Item A" },
    timestamp: "2026-01-01T00:00:01Z",
  });

  // The terminal submit call: `warehouseRegion` is the entry body's own
  // top-level field, genuinely re-referenced here (must resolve via
  // `payload.warehouseRegion`, and must be discovered into PayloadSchema so
  // the emitted contract.ts typechecks). `priorityRank`, `branchTag`, and
  // `isPromoted` are unrelated, distinctly-typed fields whose values
  // coincidentally equal the three deeply-nested leaves above — none may be
  // sourced from those leaves.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      warehouseRegion: WAREHOUSE_REGION_VALUE,
      priorityRank: PRIORITY_RANK_VALUE,
      branchTag: BRANCH_TAG_VALUE,
      isPromoted: IS_PROMOTED_VALUE,
    }),
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:02Z",
  });

  return [listing, detail, submit];
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

describe("recon-generate CLI — combined schema-parity + multi-typed value-coincidence regression", () => {
  it("typechecks the emitted contract.ts clean AND sources every collision-shaped body field only from its own name-correlated accessor", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-schema-body-value-coincidence-combined-regression-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `schema-body-value-coincidence-combined-regression-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog listing" },
          { step: "view item detail" },
          { step: "select item", submitStep: true },
        ],
        submitEndpointPattern: "catalog/select",
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

    // The fold/drill-loop is genuine — a per-item loop over the listing's
    // own array, not a hardcoded per-item call.
    expect(contract).toMatch(/\.items;\n\s*for\s*\(const \w+ of \w+\)/);

    // Isolate the submit call's request-body template literal.
    const bodyLineMatch = contract.match(/catalog\/select\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(bodyLineMatch, contract).not.toBeNull();
    const bodyTemplate = bodyLineMatch![1]!;

    // The entry body's own field must round-trip via `payload.<field>`
    // discovery — the report's schema/body-emission parity hook.
    const warehouseRegionLine = bodyTemplate.match(/"warehouseRegion"\s*:\s*"?\$\{([^}]*)\}"?/);
    expect(warehouseRegionLine, bodyTemplate).not.toBeNull();
    expect(warehouseRegionLine![1]).toMatch(/payload\.warehouseRegion/);

    // None of the three distinctly-typed collision fields may be spliced
    // from the unrelated, name-uncorrelated deep leaf they merely happen to
    // equal in value — the report's value-coincidence threading hook.
    const priorityRankLine = bodyTemplate.match(/"priorityRank"\s*:\s*"?([^,\n}]*)"?/);
    if (priorityRankLine && priorityRankLine[1]!.includes("${")) {
      expect(priorityRankLine[1]).not.toMatch(/sortOrder/i);
    }
    const branchTagLine = bodyTemplate.match(/"branchTag"\s*:\s*"?([^,\n}]*)"?/);
    if (branchTagLine && branchTagLine[1]!.includes("${")) {
      expect(branchTagLine[1]).not.toMatch(/regionCode/i);
    }
    const isPromotedLine = bodyTemplate.match(/"isPromoted"\s*:\s*"?([^,\n}]*)"?/);
    if (isPromotedLine && isPromotedLine[1]!.includes("${")) {
      expect(isPromotedLine[1]).not.toMatch(/isFeatured/i);
    }

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(bodyTemplate).not.toMatch(/\$\{[^}]*\$\{/);

    // The emitted contract.ts must typecheck with zero diagnostics against
    // the discovered PayloadSchema — the report's other defect. Scoped
    // tsconfig mirrors the sibling tsc-e2e tests' own throwaway-tsconfig
    // pattern rather than running the whole project's `pnpm run typecheck`.
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.schema-body-value-coincidence-combined-regression.${process.pid}.json`
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
    const referencesEmittedFile = diagnostics.includes("contract.ts");
    expect(referencesEmittedFile, diagnostics).toBe(false);
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
