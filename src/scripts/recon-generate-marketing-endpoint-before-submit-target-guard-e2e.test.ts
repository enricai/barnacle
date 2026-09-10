import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's second, position-sensitive verification hook: a
 * same-host, unthreaded marketing/promotions-widget capture (generalized to
 * a generic "site-banner" endpoint) that lands strictly BEFORE the last
 * capture matching a DECLARED `submitEndpointPattern` must not abort
 * generation. truncateActionSequenceAtSubmitPattern keeps everything up to
 * and including the last pattern match, so a noise capture positioned there
 * stays in the truncated slice — distinct from
 * recon-generate-marketing-endpoint-noise-guard-e2e.test.ts, whose flow
 * declares no submitEndpointPattern at all.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function noiseCapture(): Capture {
  return {
    timestamp: "2024-01-01T00:00:05.500Z",
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

describe("recon-generate: noise capture before the last declared submitEndpointPattern match", () => {
  it("exits 0 and drops the noise capture's fields when it precedes the last submit-pattern match", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-noise-before-submit-target-"));
    const runRoot = join(workDir, "run");
    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    // The fixture's last two captures both PUT to /validate — the declared
    // pattern below matches both, so the last match is the final capture.
    // Inserting the noise capture immediately before the second-to-last
    // capture places it strictly before that last match while still inside
    // the range truncateActionSequenceAtSubmitPattern's slice(0,
    // lastMatchIndex + 1) keeps.
    const allCaptures = [
      ...actionCaptures.slice(0, -2),
      noiseCapture(),
      ...actionCaptures.slice(-2),
    ];
    writeRunDir(runRoot, allCaptures);

    const siteId = `recon-noise-before-submit-target-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "fill out applicant, address, contact, employment, and attachment sections" },
          { step: "validate submitted sections", submitStep: true },
        ],
        submitEndpointPattern: "/validate$",
        requireSubmitEndpointMatch: true,
      })
    );

    const result = runGenerate(siteId, runRoot);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain("webBannerImageUrl");
    expect(contract).not.toContain("site-banner");
  }, 30_000);
});
