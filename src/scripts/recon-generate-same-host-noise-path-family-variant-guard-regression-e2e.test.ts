import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Dedicated regression for the report's required_item #2: a same-host
 * marketing/promotions-style noise endpoint must be excluded purely via
 * structural isolation, without needing a `*Url`-suffixed response field
 * to trigger the required-URL-field self-heal guard. This is isolated
 * from recon-generate-repeated-endpoint-noise-family-combined-e2e.test.ts
 * (which also proves the unrelated collapse mechanism) so the noise-family
 * guard has its own standalone, canonically-named proof, using two
 * distinct path/query noise variants instead of the single variant covered
 * by recon-generate-same-host-noise-path-family-query-variant-guard-e2e.test.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PROMOTIONS_URL = "https://api.example.com/promotions-spa/banner";

function genuineChainCaptures(): Capture[] {
  return buildMultiEndpointSubmissionActionSteps().map((step) => step.capture);
}

// Two same-noise-family marketing/promotions-style path/query variants on
// the same host — sharing the repeated meaningful `promotions-spa/banner`
// path segment but with two DIFFERENT path/query shapes — neither of which
// carries a `*Url`-suffixed field, so the required-URL-field self-heal
// guard cannot see them. They must still be excluded, purely via
// structural isolation.
function noiseVariantCaptures(): Capture[] {
  const noiseVariantOne = buildCapture({
    url: `${PROMOTIONS_URL}?slot=footer`,
    requestPostData: '{"pageId":"listings"}',
    responseBody: { headline: "Limited-time offer", impressionCount: 1 },
    timestamp: "2024-01-01T00:00:03Z",
  });
  const noiseVariantTwo = buildCapture({
    url: `${PROMOTIONS_URL}/2?slot=header`,
    requestPostData: '{"pageId":"home"}',
    responseBody: { headline: "Seasonal deal", impressionCount: 7 },
    timestamp: "2024-01-01T00:00:04Z",
  });
  return [noiseVariantOne, noiseVariantTwo];
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

describe("recon-generate CLI — same-host noise path-family variant guard regression", () => {
  it("excludes both noise path/query variants while retaining the genuine own-backend chain", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-noise-path-family-variant-guard-regression-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, [...genuineChainCaptures(), ...noiseVariantCaptures()]);

    const siteId = `noise-path-family-variant-guard-regression-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "fill out applicant, address, contact, employment, and attachment sections" },
          { step: "submit address section", submitStep: true },
        ],
        submitEndpointPattern: "validate",
        requireSubmitEndpointMatch: true,
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The genuine own-backend chain survives.
    expect(contract).toContain("/applications");
    expect(contract).toContain("/address");
    expect(contract).toContain("/validate");

    // Neither same-noise-family marketing/promotions path/query variant
    // survives into the emitted contract, and no *Url-suffixed field was
    // needed to trigger the exclusion.
    expect(contract).not.toContain("promotions-spa/banner");
    expect(contract).not.toContain("impressionCount");
  }, 30_000);
});
