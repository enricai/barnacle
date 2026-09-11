import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildManyRepeatPagedListingDrillWithNoiseVariantActionSteps } from "@/scripts/recon-generate-multicall-fixture";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * The report's second distinct problem, isolated from the collapse fix
 * covered by recon-generate-rest-repeated-endpoint-collapse-e2e.test.ts:
 * same-path-family structural-relevance exclusion must not require a
 * `*Url`-suffixed field to trigger. Mirrors
 * recon-generate-same-host-marketing-noise-guard-fixture-e2e.test.ts's
 * shape, but swaps its `webBannerImageUrl`-bearing noiseCapture() for the
 * no-*Url-field, alternate-query-string noise variant from
 * buildManyRepeatPagedListingDrillWithNoiseVariantActionSteps — the exact
 * case the required-URL-field self-heal guard cannot see, since it never
 * carries a `*Url` field to attribute in the first place. It must still be
 * excluded, purely on same-host structural isolation.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function noiseVariantCapture(): Capture {
  const [noiseStep] = buildManyRepeatPagedListingDrillWithNoiseVariantActionSteps(1, 1).slice(-1);
  return noiseStep!.capture;
}

function writeRunDir(runRoot: string, captures: Capture[]): void {
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    const filename = `${String(index).padStart(3, "0")}-capture.json`;
    writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
  });
}

function runGenerate(siteId: string, runRoot: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate: same-path-family noise exclusion does not require a *Url-suffixed field", () => {
  it("excludes the query-string-variant noise capture in every form while keeping the real chain's calls", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-noise-path-family-query-variant-guard-"));
    const runRoot = join(workDir, "run");
    const noiseCapture = noiseVariantCapture();
    const noisePath = new URL(noiseCapture.url).pathname;
    const body = noiseCapture.responseBody as Record<string, unknown>;
    expect(Object.keys(body).some((key) => key.endsWith("Url"))).toBe(false);

    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    const submitCapture = actionCaptures[actionCaptures.length - 1]!;
    const submitPath = new URL(submitCapture.url).pathname;
    const allCaptures = [noiseCapture, ...actionCaptures];
    writeRunDir(runRoot, allCaptures);

    const siteId = `noise-path-family-query-variant-guard-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "fill out applicant, address, contact, employment, and attachment sections" },
          { step: "submit address section", submitStep: true },
        ],
      })
    );

    const result = runGenerate(siteId, runRoot);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain(noisePath);
    expect(contract).not.toContain("promotions-spa/banner");
    expect(contract).not.toContain("impressionCount");
    expect(contract).toContain(submitPath);
  }, 30_000);
});
