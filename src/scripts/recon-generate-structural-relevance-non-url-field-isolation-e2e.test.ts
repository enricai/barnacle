import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that structural relevance excludes a same-host noise capture's
 * fields at admission time, not merely because those fields happen to be
 * Url-suffixed. unreferencedRequiredUrlFields (src/scripts/recon-generate.ts)
 * matches fields whose name contains "Url" only, so a required field with no
 * "Url" substring never trips that guard and was never caught by the
 * pre-existing self-heal (docs/recon-generate-host-gated-action-sequence-
 * admits-unrelated-marketing-endpoint-tripping-required-url-field-guard.md).
 * Mirrors the harness of
 * recon-generate-same-host-marketing-noise-schema-isolation-e2e.test.ts, but
 * swaps the noise capture's leaked field for a plain string field
 * (bannerHeadline) so a passing result here is evidence the exclusion
 * happens because `isStructurallyIsolatedCapture` (src/recon/capture-
 * filters.ts) drops the noise capture from the host-gated pool BEFORE
 * schema inference ever sees it — not because of the field-name-scoped
 * *Url guard, and not gated on a declared submitEndpointPattern.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "api.example.com";
const NOISE_PATH_PREFIX = "/site-banner";

/**
 * A same-host marketing widget capture that fires on page load and is never
 * threaded into the resolved action sequence. Its response carries a
 * required field with no "Url" substring, so it cannot trip
 * unreferencedRequiredUrlFields regardless of structural relevance.
 */
function noiseCapture(): Capture {
  return {
    timestamp: "2024-01-01T00:00:00.500Z",
    phase: "home",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}${NOISE_PATH_PREFIX}`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: '{"pageId":"home"}',
    responseHeaders: { "content-type": "application/json" },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
    responseBody: {
      bannerHeadline: "Limited time offer",
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

describe("recon-generate CLI — non-Url same-host noise field must not contaminate the schema", () => {
  it("exits 0, emits the real chain, and emits no fields traceable to the noise capture", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-structural-relevance-non-url-field-e2e-"));
    const runRoot = join(workDir, "run");

    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    writeRunDir(runRoot, [actionCaptures[0]!, noiseCapture(), ...actionCaptures.slice(1)]);

    const siteId = `structural-relevance-non-url-field-isolation-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeSiteFlow(siteOutDir);

    const result = generate(runRoot, siteId);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The real chain's endpoint paths must be present.
    expect(contract).toContain("/applicant");
    expect(contract).toContain("/address");
    expect(contract).toContain("/validate");

    // No trace of the noise capture's field or its distinct path prefix.
    expect(contract).not.toContain("bannerHeadline");
    expect(contract).not.toContain(NOISE_PATH_PREFIX);
  }, 30_000);
});
