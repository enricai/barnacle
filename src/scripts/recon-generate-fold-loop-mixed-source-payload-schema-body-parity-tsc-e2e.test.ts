import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's defect 1 in the shape it actually occurred: a fold/drill
 * loop's per-item body rewrite AND several directly-substituted top-level
 * filter fields emitted from the SAME generation pass. The existing parity
 * e2e tests each isolate a single field source — one drives only a fold-loop
 * body field (recon-generate-fold-loop-body-payload-field-schema-tsc-e2e.test.ts),
 * the other only entry-action/top-level fields
 * (recon-generate-1-12-50-payload-schema-body-field-parity-tsc-e2e.test.ts).
 * Neither combines both mechanisms in one submit body, which is where the
 * report's TS2339 errors on `currency`/`region`/`storeId`/`page`/
 * `exploreMorePage`-shaped fields actually came from: the fold-loop's
 * discovered-field registration and the top-level substitution pass must
 * both feed the same PayloadSchema, not overwrite or shadow each other.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST =
  "www.fold-loop-mixed-source-payload-schema-body-parity-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// Long enough to clear MIN_STATE_VALUE_LENGTH (8) and identical across every
// per-item detail capture, so it becomes a fold-loop-only body accessor
// (`${payload.storeRegion}`) rather than a threaded join field.
const STORE_REGION_VALUE = "REGION-WEST-DISTRIBUTION-01";

// Directly-substituted top-level filter fields, sourced from outside the
// loop (the list/entry action), re-sent verbatim on the submit body.
const CURRENCY_VALUE = "USD-DISPLAY-CURRENCY";
const LOCALE_VALUE = "en-US-STOREFRONT-LOCALE";
const PAGE_VALUE = "PAGE-CURSOR-TOKEN-01";

function fixtureCaptures(): Capture[] {
  const listPage = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({
      currency: CURRENCY_VALUE,
      locale: LOCALE_VALUE,
      page: PAGE_VALUE,
    }),
    responseBody: {
      totalPages: 1,
      results: [{ itemId: "item-a" }, { itemId: "item-b" }, { itemId: "item-c" }],
    },
    timestamp: "2026-05-01T00:00:00Z",
  });
  // Each per-item detail call carries its own `storeRegion` field, spliced
  // only inside the fold loop's per-item body rewrite — never present on the
  // entry action, so no other discovered-field source could register it.
  const detailA = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-a", storeRegion: STORE_REGION_VALUE }),
    responseBody: { storeCode: "store-42" },
    timestamp: "2026-05-01T00:00:01Z",
  });
  const detailB = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-b", storeRegion: STORE_REGION_VALUE }),
    responseBody: { storeCode: "store-43" },
    timestamp: "2026-05-01T00:00:02Z",
  });
  const detailC = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-c", storeRegion: STORE_REGION_VALUE }),
    responseBody: { storeCode: "store-44" },
    timestamp: "2026-05-01T00:00:03Z",
  });
  // The submit body re-sends the entry action's own top-level filter fields
  // verbatim, in the same generation pass as the fold loop above.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      currency: CURRENCY_VALUE,
      locale: LOCALE_VALUE,
      page: PAGE_VALUE,
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

describe("recon-generate CLI + tsc --noEmit — fold-loop body field mixed with top-level substituted filter fields", () => {
  it("declares both the fold-loop's per-item field and every top-level filter field on PayloadSchema and typechecks clean", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-fold-loop-mixed-source-payload-schema-body-parity-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `fold-loop-mixed-source-schema-parity-e2e-test${process.pid}`;
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

    // A genuine multi-item fold loop, not a hardcoded per-item call.
    expect(contract).toMatch(/for\s*\(const \w+ of \w+\)/);

    // The fold-loop's own per-item detail request splices `storeRegion` as a
    // payload accessor, and the top-level filter fields splice as their own
    // accessors on the submit body.
    expect(contract).toMatch(/"storeRegion":"\$\{payload\.storeRegion\}"/);
    expect(contract).toMatch(/"currency":"\$\{payload\.currency\}"/);
    expect(contract).toMatch(/"locale":"\$\{payload\.locale\}"/);
    expect(contract).toMatch(/"page":"\$\{payload\.page\}"/);

    // PayloadSchema must declare every field referenced by both the
    // fold-loop body rewrite AND the top-level substitution pass — the core
    // invariant this fixture pins.
    expect(contract).toMatch(/storeRegion:\s*z\.string\(\),/);
    expect(contract).toMatch(/currency:\s*z\.string\(\),/);
    expect(contract).toMatch(/locale:\s*z\.string\(\),/);
    expect(contract).toMatch(/page:\s*z\.string\(\),/);

    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.fold-loop-mixed-source-payload-schema-body-parity.${process.pid}.json`
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
