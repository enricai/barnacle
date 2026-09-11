import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Encodes the report's second explicit verification hook: a same-host,
 * unthreaded marketing/promotions-style capture placed BEFORE the real
 * chain's declared submit target (rather than interleaved, as covered by
 * recon-generate-marketing-endpoint-noise-guard-e2e.test.ts) must not
 * abort generation. Proves the fix narrows by structural relevance, not by
 * capture ordering/position.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function noiseCapture(): Capture {
  return {
    timestamp: "2023-12-31T23:59:59.500Z",
    phase: "home",
    method: "POST",
    url: "https://api.example.com/site-banner",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: '{"pageId":"home"}',
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      webBannerImageUrl: "https://cdn.example.com/banner.png",
      mobileWebBannerImageUrl: "https://cdn.example.com/banner-mobile.png",
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function noiseCaptureQueryVariant(): Capture {
  return {
    timestamp: "2023-12-31T23:59:59.700Z",
    phase: "home",
    method: "POST",
    url: "https://api.example.com/site-banner?campaign=summer",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: '{"pageId":"home","campaign":"summer"}',
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      webBannerImageUrl: "https://cdn.example.com/banner-summer.png",
      mobileWebBannerImageUrl: "https://cdn.example.com/banner-summer-mobile.png",
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

describe("recon-generate: required-URL-field guard self-heals when the noise capture precedes the submit target", () => {
  it("exits 0 and retains the real chain's submit target when the marketing capture is chronologically first", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-noise-url-guard-before-submit-"));
    const runRoot = join(workDir, "run");
    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    const submitCapture = actionCaptures[actionCaptures.length - 1]!;
    const submitPath = new URL(submitCapture.url).pathname;
    const allCaptures = [noiseCapture(), noiseCaptureQueryVariant(), ...actionCaptures];
    writeRunDir(runRoot, allCaptures);

    const siteId = `recon-noise-url-guard-before-submit-test-${process.pid}`;
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
    expect(contract).not.toContain("webBannerImageUrl");
    expect(contract).not.toContain("site-banner");
    expect(contract).not.toContain("banner-summer");
    expect(contract).toContain(submitPath);
  }, 30_000);
});
