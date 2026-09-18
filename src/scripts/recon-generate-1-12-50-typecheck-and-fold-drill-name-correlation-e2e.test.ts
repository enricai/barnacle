import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Combines the report's two "Verification hooks" into one repro: a
 * fold/drill-loop (a listing endpoint whose response is an array folded
 * per-item against a detail endpoint) plus (a) a deeply-nested, unrelated
 * numeric leaf on one listing item that coincidentally shares its value with
 * a later, differently-named submit-body field, and (b) the entry (listing)
 * request body's own top-level fields re-referenced downstream via
 * `payload.<field>`. Asserts the emitted contract.ts both typechecks with
 * zero diagnostics AND never binds the coincidence field to the
 * name-uncorrelated nested local.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.fold-drill-typecheck-name-correlation-fixture.example.com";
const LISTING_URL = `https://${OWN_BACKEND_HOST}/catalog/listing/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/select/`;

// Entry body's own top-level fields — must be re-referenced downstream via
// `payload.region`/`payload.currency`, not re-scraped from anywhere else.
const REGION_VALUE = "us-east";
const CURRENCY_VALUE = "USD";

// A deeply-nested, unrelated numeric leaf on the FIRST listing item. Kept
// under recon-generate's MIN_STATE_VALUE_LENGTH (8) so the only way it could
// thread into the submit body is via the length-floor bypass that requires
// field-name correlation — the guard under test.
const SORT_ORDER_VALUE = 3;
// The submit body's own, differently-named field that coincidentally shares
// the SAME value as the unrelated nested leaf above.
const PRIORITY_RANK_VALUE = SORT_ORDER_VALUE;

function fixtureCaptures(): Capture[] {
  const listing = buildCapture({
    url: LISTING_URL,
    requestPostData: JSON.stringify({ region: REGION_VALUE, currency: CURRENCY_VALUE, page: 1 }),
    responseBody: {
      page: 1,
      items: [
        {
          itemId: "item-a",
          meta: { ranking: { display: { sortOrder: SORT_ORDER_VALUE } } },
        },
        {
          itemId: "item-b",
          meta: { ranking: { display: { sortOrder: 9 } } },
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

  // The terminal submit call: `region`/`currency` are the entry body's own
  // top-level fields, genuinely re-referenced here (must resolve via
  // `payload.region`/`payload.currency`). `priorityRank` is an unrelated
  // field whose value coincidentally equals the first listing item's
  // deeply-nested `sortOrder` leaf — it must never be sourced from that
  // leaf, only from a name-correlated source or an unthreaded literal.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      region: REGION_VALUE,
      currency: CURRENCY_VALUE,
      priorityRank: PRIORITY_RANK_VALUE,
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

describe("recon-generate CLI — fold/drill-loop contract typechecks and never coincidence-threads an unrelated nested leaf", () => {
  it("emits a zero-diagnostic contract.ts whose submit body sources every field from its own name-correlated accessor", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-fold-drill-typecheck-name-correlation-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `fold-drill-typecheck-name-correlation-e2e-test${process.pid}`;
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

    // Verification hook (b): the fold/drill-loop is real — a genuine
    // per-item loop over the listing's own array, not a hardcoded per-item
    // call.
    expect(contract).toMatch(
      /\.items;\n\s*await Promise\.allSettled\(\n\s*\(\w+\)\.map\(async \(\w+\) => \{/
    );

    // Isolate the submit call's request-body template literal.
    const bodyLineMatch = contract.match(/catalog\/select\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(bodyLineMatch, contract).not.toBeNull();
    const bodyTemplate = bodyLineMatch![1]!;

    // Verification hook (a): the entry body's own top-level fields are
    // genuinely re-referenced downstream via `payload.<field>`.
    const regionLine = bodyTemplate.match(/"region"\s*:\s*"?\$\{([^}]*)\}"?/);
    expect(regionLine, bodyTemplate).not.toBeNull();
    expect(regionLine![1]).toMatch(/payload\.region/);
    const currencyLine = bodyTemplate.match(/"currency"\s*:\s*"?\$\{([^}]*)\}"?/);
    expect(currencyLine, bodyTemplate).not.toBeNull();
    expect(currencyLine![1]).toMatch(/payload\.currency/);

    // Verification hook (b)'s core assertion: `priorityRank` must never be
    // sourced from the unrelated, deeply-nested `sortOrder` local — a
    // grep-able name-correlation guard, not a bespoke ad-hoc check.
    const priorityRankLine = bodyTemplate.match(/"priorityRank"\s*:\s*"?([^,\n]*)"?/);
    if (priorityRankLine && priorityRankLine[1]!.includes("${")) {
      expect(priorityRankLine[1]).not.toMatch(/sortOrder/i);
    }

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(bodyTemplate).not.toMatch(/\$\{[^}]*\$\{/);

    // Verification hook (a): the emitted contract.ts must typecheck with
    // zero diagnostics — the report's other defect (schema/body-emission
    // disagreement). Scoped tsconfig mirrors recon-generate-tsc-clean-emit-
    // e2e.test.ts's own throwaway-tsconfig pattern rather than running the
    // whole project's `pnpm run typecheck`.
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.fold-drill-typecheck-name-correlation.${process.pid}.json`
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
