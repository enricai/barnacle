import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Directly encodes the report's primary verification hook: a same-host
 * marketing/promotions-style capture (distinct path prefix, response
 * carrying *Url-suffixed fields nothing downstream references) interleaved
 * with a real own-backend REST chain (create -> per-section POST -> PUT
 * validate, via {@link buildMultiEndpointSubmissionActionSteps}) must not
 * abort recon-generate and must not contaminate the emitted contract.
 * Mirrors the spawnSync/tmpdir/writeRunDir/writeSiteFlow harness of
 * recon-generate-thirdparty-telemetry-action-sequence-host-provenance-e2e.test.ts.
 * Unlike that sibling, the noise capture here is on the SAME host as the
 * real chain, so it passes isAllowedFixtureHost host-gating exactly as
 * reported (src/recon/capture-filters.ts:127) — the report's own repro
 * (docs/recon-generate-host-gated-action-sequence-admits-unrelated-marketing-
 * endpoint-tripping-required-url-field-guard.md) hit this specifically on a
 * multi-step submission flow whose payload schema folds every action
 * capture's fields together, which a simple two-endpoint action sequence
 * does not exercise — hence reusing the proven multi-endpoint fixture here
 * rather than a shorter ad hoc chain.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "api.example.com";
const MARKETING_NOISE_PATH_PREFIX = "/site-banner";

/**
 * A same-host marketing/promotions widget capture that fires on page load
 * and is never threaded into the resolved action sequence. Its response
 * carries required *Url-suffixed fields that nothing downstream reads.
 */
function marketingNoiseCapture(): Capture {
  return {
    timestamp: "2024-01-01T00:00:00.500Z",
    phase: "home",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}${MARKETING_NOISE_PATH_PREFIX}`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: '{"pageId":"home"}',
    responseHeaders: { "content-type": "application/json" },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
    responseBody: {
      webBannerImageUrl: "https://cdn.example.com/banner.png",
      mobileWebBannerImageUrl: "https://cdn.example.com/banner-mobile.png",
    },
  };
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

function writeSiteFlow(siteOutDir: string): void {
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
}

function generate(runRoot: string, siteId: string) {
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

describe("recon-generate CLI — same-host marketing noise must not abort generation or contaminate the schema", () => {
  it("exits 0, emits the real chain, and emits no fields traceable to the marketing capture", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-same-host-marketing-noise-e2e-"));
    const runRoot = join(workDir, "run");

    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    writeRunDir(runRoot, [actionCaptures[0]!, marketingNoiseCapture(), ...actionCaptures.slice(1)]);

    const siteId = `same-host-marketing-noise-schema-isolation-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeSiteFlow(siteOutDir);

    const result = generate(runRoot, siteId);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The real chain's endpoint paths must be present.
    expect(contract).toContain("/applicant");
    expect(contract).toContain("/address");
    expect(contract).toContain("/validate");

    // No trace of the marketing capture's fields or its distinct path prefix.
    expect(contract).not.toContain("webBannerImageUrl");
    expect(contract).not.toContain("mobileWebBannerImageUrl");
    expect(contract).not.toContain(MARKETING_NOISE_PATH_PREFIX);

    // The marketing capture must be excluded upfront by structural relevance,
    // not rescued reactively by the self-heal retry (recon-generate.ts's
    // healUnreferencedUrlFieldsOnce), which only runs after a first attempt
    // already failed the required-URL-field guard.
    expect(result.stdout).not.toContain("excluding them and re-generating once");
    expect(result.stderr).not.toContain("excluding them and re-generating once");
  }, 30_000);
});
