import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins bugfix-001's structural fix at the CLI/tsc boundary, driving the real
 * `recon:generate --force` end to end over a genuine multi-item drill/fold
 * loop (`for (const item of foldItems)`, not a single-chain fixture): the
 * per-item detail request carries its own `region` field, long enough to
 * clear MIN_STATE_VALUE_LENGTH so it becomes a caller-supplied
 * `${payload.region}` accessor spliced INSIDE the fold loop's per-item body
 * rewrite (emitMultiStepExecuteHttp's `parameterize` closure) rather than on
 * the entry action, where the report's schema/body-emission disagreement
 * (TS2339/TS7053/TS18046) was confirmed. Asserts the regenerated contract.ts
 * both declares `region` on PayloadSchema and passes
 * `tsc --noEmit` with zero diagnostics, matching the report's own suggested
 * verification hook (a).
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.fold-loop-body-payload-field-schema-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// Long enough to clear MIN_STATE_VALUE_LENGTH (8) so it becomes a caller
// payload accessor rather than a frozen literal — and identical across every
// per-item detail capture below, so it is NOT a threaded join field (it
// doesn't vary with the item), only a body field the loop's own per-item
// request rewrite splices as `${payload.region}`.
const REGION_VALUE = "REGION-WEST-DISTRIBUTION-01";

function fixtureCaptures(): Capture[] {
  const listPage = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ resultPage: 1 }),
    responseBody: {
      totalPages: 1,
      results: [{ itemId: "item-a" }, { itemId: "item-b" }, { itemId: "item-c" }],
    },
    timestamp: "2026-04-01T00:00:00Z",
  });
  // Each per-item detail call carries its own `region` field, spliced only
  // inside the fold loop's per-item body rewrite — never present on the
  // entry action, so no other discovered-field source could register it.
  const detailA = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-a", region: REGION_VALUE }),
    responseBody: { storeCode: "store-42" },
    timestamp: "2026-04-01T00:00:01Z",
  });
  const detailB = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-b", region: REGION_VALUE }),
    responseBody: { storeCode: "store-43" },
    timestamp: "2026-04-01T00:00:02Z",
  });
  const detailC = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-c", region: REGION_VALUE }),
    responseBody: { storeCode: "store-44" },
    timestamp: "2026-04-01T00:00:03Z",
  });
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({ itemId: "item-a" }),
    responseBody: { ok: true },
    timestamp: "2026-04-01T00:00:04Z",
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

describe("recon-generate CLI + tsc --noEmit — fold-loop per-item body payload field parity", () => {
  it("declares a fold-loop-only payload.<field> accessor on PayloadSchema and typechecks clean", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-fold-loop-body-payload-field-schema-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `fold-loop-body-payload-field-schema-e2e-test${process.pid}`;
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

    // The fold-loop's own per-item detail request splices `region` as a
    // payload accessor.
    expect(contract).toMatch(/"region":"\$\{payload\.region\}"/);

    // PayloadSchema must declare the field the loop body actually references
    // — the core invariant this fix enforces.
    expect(contract).toMatch(/region:\s*z\.string\(\),/);

    tsconfigPath = join(REPO_ROOT, `tsconfig.fold-loop-body-payload-field-schema.${process.pid}.json`);
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
