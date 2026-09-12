import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's problem #2 for the one combination no existing test
 * exercises: a declared submitEndpointPattern anchor (requireSubmitEndpointMatch
 * + ownBackendHostnames) present alongside a same-host, same-path-family noise
 * pair where only ONE variant carries a `*Url`-suffixed field. The anchored
 * code path (recon-generate.ts's unfilteredHeuristicActionCaptures) calls
 * extractActionSequence with submitPatterns forced to null, so an anchor
 * being declared must not skip the *Url self-heal's family-broadening
 * exclusion (identifyNoiseCapturesForFields / isSamePathFamily) that
 * recon-generate-noise-family-self-heal-sibling-variant-regression-e2e.test.ts
 * pins with no anchor declared at all.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const NOISE_HOST = "https://api.example.com";
const OWN_BACKEND_HOST = "api.example.com";
// Compound-segment sibling paths sharing the "marketing" structural token,
// same host as the real submission chain's fixture host.
const TRIGGERING_NOISE_URL = `${NOISE_HOST}/marketing-spa/banner`;
const SIBLING_NOISE_URL = `${NOISE_HOST}/marketing-spa/banner/2`;

function triggeringNoiseCapture(): Capture {
  return {
    timestamp: "2024-01-01T00:00:00.400Z",
    phase: "home",
    method: "POST",
    url: `${TRIGGERING_NOISE_URL}?slot=footer`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: '{"pageId":"home"}',
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      campaignBannerUrl: "https://cdn.example.com/campaign-banner.png",
      impressionCount: 3,
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function siblingNoiseCapture(): Capture {
  return {
    timestamp: "2024-01-01T00:00:00.600Z",
    phase: "home",
    method: "POST",
    url: `${SIBLING_NOISE_URL}?slot=header`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: '{"pageId":"home"}',
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      headline: "Seasonal deal",
      impressionCount: 9,
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
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

describe("recon-generate: anchored submitEndpointPattern does not disable self-heal-family noise exclusion", () => {
  it("excludes the *Url-bearing noise capture and its untriggered same-family sibling even with a submit-endpoint anchor declared", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-same-host-noise-family-anchored-self-heal-sibling-")
    );
    const runRoot = join(workDir, "run");

    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    const submitCapture = actionCaptures[actionCaptures.length - 1]!;
    const submitPath = new URL(submitCapture.url).pathname;

    const allCaptures = [
      actionCaptures[0]!,
      triggeringNoiseCapture(),
      siblingNoiseCapture(),
      ...actionCaptures.slice(1),
    ];
    writeRunDir(runRoot, allCaptures);

    const siteId = `noise-family-anchored-self-heal-sibling-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "fill out applicant, address, contact, employment, and attachment sections" },
          { step: "submit address section", submitStep: true },
        ],
        submitEndpointPattern: submitPath,
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = runGenerate(siteId, runRoot);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The self-heal-triggering variant: excluded field and path.
    expect(contract).not.toContain("campaignBannerUrl");
    expect(contract).not.toContain("marketing-spa/banner");

    // Its untriggered sibling — no *Url field, so the first self-heal pass
    // never sees it — must still be excluded via same-path-family broadening,
    // even with a submitEndpointPattern anchor declared.
    expect(contract).not.toContain("marketing-spa/banner/2");
    expect(contract).not.toContain("impressionCount");
    expect(contract).not.toContain("Seasonal deal");

    // The genuine multi-step chain's submit call survives.
    expect(contract).toContain(submitPath);
  }, 30_000);
});
