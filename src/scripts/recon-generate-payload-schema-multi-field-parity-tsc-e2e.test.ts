import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Generalizes the single-field payload-schema/body parity pin
 * (recon-generate-1-12-50-payload-schema-body-field-parity-tsc-e2e.test.ts)
 * to the report's actual repro shape: five distinctly-typed fields (three
 * strings, two numbers) referenced simultaneously in one request body, not
 * one field in isolation. If field registration only handles the
 * single-field case, the emitted contract.ts references undeclared
 * `payload.<field>` accessors for the remaining fields and tsc reports
 * TS2339 for each.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.payload-schema-multi-field-parity-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// Long enough to clear MIN_STATE_VALUE_LENGTH (8) so the string fields are
// splice candidates rather than staying frozen literals.
const REGION_VALUE = "REGION-EAST-DISTRIBUTION-07";
const CURRENCY_VALUE = "CURRENCY-USD-STANDARD";
const STORE_ID_VALUE = "STORE-ID-99887766";

function fixtureCaptures(): Capture[] {
  const listPage1 = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({
      region: REGION_VALUE,
      currency: CURRENCY_VALUE,
      storeId: STORE_ID_VALUE,
      page: 1,
      exploreMorePage: 2,
    }),
    responseBody: { totalPages: 2, results: [{ itemId: "item-a" }] },
    timestamp: "2026-02-01T00:00:00Z",
  });
  const listPage2 = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({
      region: REGION_VALUE,
      currency: CURRENCY_VALUE,
      storeId: STORE_ID_VALUE,
      page: 2,
      exploreMorePage: 3,
    }),
    responseBody: { totalPages: 2, results: [{ itemId: "item-b" }] },
    timestamp: "2026-02-01T00:00:01Z",
  });
  const detail = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-a" }),
    responseBody: { storeCode: "store-42" },
    timestamp: "2026-02-01T00:00:02Z",
  });
  // Re-sends all five entry-action fields verbatim — the exact condition
  // that must produce `${payload.<field>}` splices for every one of them
  // AND matching schema declarations for all five simultaneously.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      region: REGION_VALUE,
      currency: CURRENCY_VALUE,
      storeId: STORE_ID_VALUE,
      page: 1,
      exploreMorePage: 2,
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

describe("recon-generate CLI + tsc --noEmit — simultaneous multi-field body accessors stay declared on PayloadSchema", () => {
  it("emits a contract.ts whose five simultaneously-referenced, mixed-type payload.<field> accessors all agree with PayloadSchema under tsc", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-payload-schema-multi-field-parity-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `payload-schema-multi-field-parity-e2e-test${process.pid}`;
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

    // Uniquely named and removed in `afterEach`, matching the sibling
    // single-field parity e2e's throwaway-tsconfig pattern. Emitted plugins
    // import their engine dependencies through the bare
    // `@enricai/barnacle/*` specifier (the out-of-tree operator's own
    // installed package) — this repo IS that package, and its subpaths
    // mirror `src/*` 1:1, so a `paths` override resolves the emitted imports
    // against source without a dist build.
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.payload-schema-multi-field-parity.${process.pid}.json`
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
