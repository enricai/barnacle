import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Closes the coverage gap
 * recon-generate-1-12-51-payload-field-priority-across-all-calls-guard.test.ts
 * explicitly disclaims: that unit test isolates the payload-vs-scraped
 * precedence question from `detectDrillDownFoldPlan`'s structural per-item
 * fold/drill loop machinery by hand-feeding `indexStateValues` the fold-loop
 * force-include exemption directly, citing "sibling fold-loop guard tests" as
 * covering the structural path instead. This drives the real `recon:generate`
 * CLI over a genuine multi-item fold/drill loop (an entry call re-sending a
 * top-level field, a per-item drill call whose response coincidentally
 * reproduces that field's value at an unrelated nested path, and a per-item
 * chained call — itself inside the SAME loop — that re-sends the field) so
 * the emitted per-item loop body is the one recon-generate.ts's payload-
 * precedence check at ~5050-5062
 * (`payloadAccessorByValue.has(value) && !producerBoundaryValues.has(value)`)
 * actually has to arbitrate over, not a hand-fed unit-level substitute.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.payload-field-precedence-inside-fold-drill-loop-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// The entry body's own top-level field — the legitimate payload source every
// later call re-sending the same name must keep reading from.
const CURRENCY_VALUE = "CURRENCY-USD-STANDARD-01";

function fixtureCaptures(): Capture[] {
  const search = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ currency: CURRENCY_VALUE, page: 1 }),
    responseBody: {
      results: [{ itemId: "item-a" }, { itemId: "item-b" }],
    },
    timestamp: "2026-01-01T00:00:00Z",
  });

  // The fold/drill-loop's per-item detail call — only item-a's is ever
  // recorded, so the fold plan must synthesize item-b's structurally. Its
  // response coincidentally reproduces the SAME field's value at an
  // unrelated nested path (`meta.currency`) — the scraped occurrence the
  // report's defect wrongly let win on later in-loop calls.
  const detail = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-a" }),
    responseBody: {
      itemId: "item-a",
      detailToken: "detail-token-item-a",
      meta: { currency: CURRENCY_VALUE },
    },
    timestamp: "2026-01-01T00:00:01Z",
  });

  // A per-item call chained off the detail response (keyed by the produced
  // `detailToken`) — still INSIDE the same fold/drill loop, not a flat
  // sequential call after it — that re-sends "currency" under the same key.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      detailToken: "detail-token-item-a",
      currency: CURRENCY_VALUE,
    }),
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:02Z",
  });

  return [search, detail, submit];
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

describe("recon-generate CLI — payload field precedence survives inside a real fold/drill loop", () => {
  it("sources a payload-matched field from payload.<field> on every call inside the loop, never from the coincidentally-equal scraped nested accessor", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-payload-field-precedence-inside-fold-drill-loop-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `payload-field-precedence-inside-fold-drill-loop-e2e-test${process.pid}`;
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

    // A genuine per-item fold/drill loop, not a hardcoded per-item call —
    // proves the fixture actually exercises detectDrillDownFoldPlan's
    // structural machinery, not a hand-fed unit-level substitute.
    expect(contract).toMatch(/\(\w+\)\.map\(async \(\w+\) => \{/);

    // The chained submit call must itself be emitted INSIDE the loop body —
    // this is the report's exact repro shape (an in-loop call re-sending the
    // field), not a flat sequential call after the loop closes.
    const loopMatch = contract.match(/\(\w+\)\.map\(async \(\w+\) => \{([\s\S]*?)\n\s*\}\)\n/);
    expect(loopMatch, contract).not.toBeNull();
    const loopBody = loopMatch![1]!;
    expect(loopBody).toMatch(/catalog\/submit\//);

    // Every occurrence of the field anywhere in the emitted contract must
    // read `payload.currency` — never a scraped/array-indexed accessor —
    // across BOTH the entry call and every in-loop call.
    const currencyOccurrences = [...contract.matchAll(/"currency"\s*:\s*"?([^,\n}]*)"?/g)];
    expect(currencyOccurrences.length).toBeGreaterThanOrEqual(2);
    for (const match of currencyOccurrences) {
      expect(match[1], contract).toContain("payload.currency");
    }

    // Never sourced from the coincidentally-equal scraped meta.currency
    // accessor on any call, including the in-loop ones.
    expect(contract).not.toMatch(/"currency"\s*:\s*"?\$\{[^}]*meta[^}]*\}/i);

    // No invalidly-nested placeholder anywhere in the emitted contract.
    expect(contract).not.toMatch(/\$\{[^}]*\$\{/);

    // The emitted contract.ts must typecheck with zero diagnostics against
    // the discovered PayloadSchema.
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.payload-field-precedence-inside-fold-drill-loop.${process.pid}.json`
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
