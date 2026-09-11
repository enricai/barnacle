import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's problem #2 for the specific two-stage interaction that
 * no existing test exercises. Two same-host, compound-path noise captures
 * that share a structural path token (e.g. `marketing-spa`) mutually vouch
 * for each other in `isStructurallyIsolatedCapture` — neither is isolated
 * from "the pool" when the pool includes its own sibling — so with no
 * `submitEndpointPattern` declared to anchor a later narrowing pass, BOTH
 * survive `extractActionSequence`'s own structural gating and enter the
 * resolved pool untouched. Only one variant's response carries a
 * `*Url`-suffixed field, which trips the required-URL-field self-heal's
 * WARN-and-regenerate retry ({@link healUnreferencedUrlFieldsOnce} in
 * recon-generate.ts). Its sibling — sharing the same structural token but
 * carrying no `*Url` field of its own, so the self-heal's first pass never
 * sees it directly — must still be excluded via `isSamePathFamily`'s
 * broadening in `identifyNoiseCapturesForFields`, not survive into the
 * emitted contract. Existing tests either cover a single self-heal-
 * triggering capture alone
 * (recon-generate-noise-capture-url-field-guard-self-heal.test.ts), two
 * *Url-less siblings together with a declared submitEndpointPattern anchor
 * (recon-generate-same-host-noise-path-family-query-variant-guard-e2e.test.ts,
 * -variant-guard-regression-e2e.test.ts,
 * -repeated-endpoint-noise-family-combined-e2e.test.ts) — none combine an
 * *Url-triggering variant with an untriggered sibling with NO anchor
 * declared, the shape that isolates the self-heal's family-broadening as
 * the only exclusion mechanism.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const NOISE_HOST = "https://api.example.com";
// Compound-segment sibling paths sharing the "marketing" structural token
// (mirroring the existing PROMOTIONS_URL fixture style): they mutually vouch
// for each other in isStructurallyIsolatedCapture, so with no
// submitEndpointPattern anchor declared, both survive structural gating and
// only the self-heal's family-broadening can tell them apart from the real
// chain.
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

describe("recon-generate: self-heal-excluded noise variant's untriggered sibling is also excluded", () => {
  it("excludes both the *Url-bearing noise capture and its *Url-less same-family sibling from the emitted contract", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-noise-family-self-heal-sibling-variant-"));
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

    const siteId = `noise-family-self-heal-sibling-variant-e2e-test-${process.pid}`;
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

    // The self-heal-triggering variant: excluded field and path.
    expect(contract).not.toContain("campaignBannerUrl");
    expect(contract).not.toContain("marketing-spa/banner");

    // Its untriggered sibling — no *Url field, so the first self-heal pass
    // never sees it — must still be excluded via same-path-family broadening.
    expect(contract).not.toContain("marketing-spa/banner/2");
    expect(contract).not.toContain("impressionCount");
    expect(contract).not.toContain("Seasonal deal");

    // The genuine multi-step chain's submit call survives.
    expect(contract).toContain(submitPath);
  }, 30_000);
});
