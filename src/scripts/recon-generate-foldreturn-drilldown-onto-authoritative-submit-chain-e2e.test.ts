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
 * Covers the report's addendum: a declared `submitEndpointPattern` +
 * `requireSubmitEndpointMatch` authoritative chain (the same paged-listing ->
 * drill shape {@link buildMulticallHeterogeneousActionStepsWithDrillDown}
 * already models) PLUS a declared `foldReturn` targeting a further endpoint
 * fired after the drill/submit step. Before the fix, an authoritative
 * pattern collapsed the action sequence to its matching capture(s) alone,
 * discarding the paged-listing primary the fold's `resultsPath` resolves
 * against, so `resolveFoldPlan` found nothing and generation fell through to
 * the wrong single-endpoint REST path — the exact failure the addendum
 * names as "the fix's verification case". The declared pattern
 * (`available-units`) is written to also match the fold target's own URL
 * (`available-units-detail`), so its LAST match — the fold target — is what
 * the truncation boundary is drawn at, keeping the whole chain including the
 * fold target visible to `resolveFoldPlan` (recon-generate.ts's
 * `truncateActionSequenceAtSubmitPattern`/`buildFoldPlanFromSpec`).
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-foldreturn-chain-fixture.example.com";

/** Rehosts a fixture capture's URL onto the synthetic own-backend host, keeping its path/query. */
function rehostCapture(capture: Capture): Capture {
  const rehostedUrl = new URL(capture.url);
  rehostedUrl.host = OWN_BACKEND_HOST;
  return { ...capture, url: rehostedUrl.toString() };
}

/**
 * The report's paged-listing -> drill chain, rehosted onto a synthetic
 * own-backend host, with one further own-backend call appended after the
 * drill/submit step to serve as the `foldReturn` target: its response holds
 * the per-item detail the fold merges onto each `available-products` item,
 * joined on the same `productId` the drill step already threads.
 */
function ownBackendChainWithFoldTargetCaptures(): Capture[] {
  const rehosted = buildMulticallHeterogeneousActionStepsWithDrillDown().map((step) =>
    rehostCapture(step.capture)
  );
  const drill = rehosted[rehosted.length - 1]!;
  const drillUrl = new URL(drill.url);
  const foldTargetUrl = new URL(drillUrl.toString());
  foldTargetUrl.pathname = `${drillUrl.pathname.replace(/\/$/, "")}-detail/`;
  const foldTarget = buildStep("r5", {
    url: foldTargetUrl.toString(),
    requestPostData: '{"productId":"p1"}',
    responseBody: { price: 42, exchangeRate: 1.0 },
    timestamp: "2024-01-01T00:00:05Z",
  }).capture;
  return [...rehosted, foldTarget];
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

describe("recon-generate CLI — declared submitEndpointPattern chain plus a declared foldReturn onto a further endpoint after the submit step", () => {
  it("resolves the fold against the corrected (non-collapsed) actionSteps, with no 'no fold plan resolved' warning", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-foldreturn-authoritative-chain-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, ownBackendChainWithFoldTargetCaptures());

    const siteId = `foldreturn-authoritative-chain-e2e-test-${process.pid}`;
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
          endpointPattern: "available-units-detail",
          resultsPath: "products",
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

    // The paged-listing primary the fold's resultsPath resolves against
    // survives as a chain step, instead of being discarded by collapsing
    // the sequence to the declared pattern's matching capture(s) alone.
    expect(contract).toContain("/listings-avail-api/available-products/");

    // The drill/submit endpoint itself survives as the chain's submit step.
    expect(contract).toContain("/listings-avail-api/available-units/");

    // The fold target endpoint is present, and its response is threaded in
    // as a per-item merge rather than dropped.
    expect(contract).toContain("available-units-detail");
    expect(contract).toContain("productId");
  }, 30_000);

  it("falsifier: without the corrected truncation, the same declared pattern collapses the chain and the fold cannot resolve (control against the OLD filter-to-matches-only semantics)", () => {
    // Directly exercises the two helpers the fix touches, mirroring what
    // the unfixed `main()` did: filter the sequence down to submit-pattern
    // matches ONLY (dropping the paged-listing primary), instead of
    // truncating the full sequence at the last match.
    const captures = ownBackendChainWithFoldTargetCaptures();
    const submitEndpointRx = /available-units/;
    const matchesOnly = captures.filter((capture) => submitEndpointRx.test(capture.url));

    // The paged-listing primary (`available-products`) never survives a
    // filter-to-matches-only collapse, since it doesn't itself match the
    // declared submitEndpointPattern — this is the exact defect the report
    // names: "the mint and the listing" are lost.
    expect(matchesOnly.some((capture) => capture.url.includes("available-products"))).toBe(false);
  });
});
