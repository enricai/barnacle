import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  buildMulticallHeterogeneousActionStepsWithDrillDown,
  buildStep,
} from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * The report's addendum names this combined shape as "the fix's
 * verification case" and states it is unexercised by any e2e test: an
 * own-backend auth mint -> paged listing (2+ pages) -> a declared
 * `submitEndpointPattern` matching a drill capture -> a SECOND, distinct
 * `foldReturn`-declared drill endpoint on the same host, plus an early
 * page-load-shaped own-backend decoy capture that matches neither the
 * declared pattern nor the fold's `endpointPattern` (mirroring the report's
 * `toggles/product-avail` false-primary). A still-present truncation defect
 * would collapse the chain to the pattern-matched capture(s) alone, dropping
 * the paged-listing primary the fold's `resultsPath` resolves against and
 * surfacing as "no fold plan resolved"; a still-present decoy defect would
 * let the unrelated page-load capture leak into the emitted contract as a
 * false primary.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-submitpattern-foldreturn-chain-fixture.example.com";
const DECOY_URL = "https://api.example.com/listings-avail-spa/error";

/** Rehosts a fixture capture's URL onto the synthetic own-backend host, keeping its path/query. */
function rehostCapture(capture: Capture): Capture {
  const rehostedUrl = new URL(capture.url);
  rehostedUrl.host = OWN_BACKEND_HOST;
  return { ...capture, url: rehostedUrl.toString() };
}

/**
 * The report's auth mint -> paged listing (2 pages) -> drill/submit chain,
 * rehosted onto a synthetic own-backend host, with a SECOND, distinct
 * drill-down call appended after the submit step to serve as the
 * `foldReturn` target — a different endpoint from the declared
 * `submitEndpointPattern`'s match, per the addendum's "second declared
 * foldReturn drill" shape. The fold target's response nests its per-item
 * results under a key (`drillResultsPath`) rather than being the array
 * itself, matching the addendum's availability-style drill response shape.
 */
function ownBackendChainWithDistinctFoldTargetCaptures(): Capture[] {
  const rehosted = buildMulticallHeterogeneousActionStepsWithDrillDown().map((step) =>
    rehostCapture(step.capture)
  );
  const drill = rehosted[rehosted.length - 1]!;
  const drillUrl = new URL(drill.url);
  const foldTargetUrl = new URL(drillUrl.toString());
  foldTargetUrl.pathname = `${drillUrl.pathname.replace(/\/$/, "")}-drilldown/`;
  const foldTarget = buildStep("r5", {
    url: foldTargetUrl.toString(),
    requestPostData: '{"productId":"p1"}',
    responseBody: { drillResults: { units: [{ unitId: "s1", price: 42 }] } },
    timestamp: "2024-01-01T00:00:05Z",
  }).capture;
  return [...rehosted, foldTarget];
}

/**
 * An early own-backend POST that fires before the chain (page-load shape),
 * matching neither the declared `submitEndpointPattern` nor the fold's
 * `endpointPattern` — the report's own-host noise (`spa/error`) it names
 * alongside `toggles/product-avail` as never part of the plugin, which this
 * test proves stays excluded from the emitted contract.
 */
function decoyPageLoadCapture(): Capture {
  return rehostCapture(
    buildStep("r-decoy", {
      url: DECOY_URL,
      requestPostData: "[]",
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:00.500Z",
    }).capture
  );
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

describe("recon-generate CLI — declared submitEndpointPattern chain plus a distinct declared foldReturn drill endpoint stays chain-preserved and decoy-free", () => {
  it("preserves the mint/paged-listing/submit chain, resolves the fold onto the second declared drill endpoint, and excludes the unrelated decoy", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-submitpattern-foldreturn-chain-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, [
      decoyPageLoadCapture(),
      ...ownBackendChainWithDistinctFoldTargetCaptures(),
    ]);

    const siteId = `submitpattern-foldreturn-chain-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "authorize session" },
          { step: "browse paged product listing" },
          { step: "drill into unit availability", submitStep: true },
        ],
        submitEndpointPattern: "available-units",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
        foldReturn: {
          endpointPattern: "available-units-drilldown",
          resultsPath: "products",
          drillResultsPath: "drillResults.units",
          joinFields: ["productId"],
        },
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;

    // The root-cause fix: a resolved fold plan must not be silently dropped
    // because the declared submitEndpointPattern collapsed the chain.
    expect(output).not.toContain("no fold plan resolved");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The mint and the paged-listing primary the fold's resultsPath
    // resolves against both survive as chain steps.
    expect(contract).toContain("/listings-avail-api/authz/private");
    expect(contract).toContain("/listings-avail-api/available-products/");

    // The declared pattern's drill/submit endpoint survives as the chain's
    // submit step.
    expect(contract).toContain("/listings-avail-api/available-units/");

    // The second, distinct foldReturn-declared drill endpoint's fold wiring
    // is present.
    expect(contract).toContain("available-units-drilldown");
    expect(contract).toContain("productId");

    // The unrelated page-load decoy — matching neither the declared
    // submitEndpointPattern nor the fold's endpointPattern — never reaches
    // the emitted contract as a false primary.
    expect(contract).not.toContain("/listings-avail-spa/error");
  }, 30_000);
});
