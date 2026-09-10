import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's headline defect (recon-generate-host-gated-action-sequence-
 * admits-unrelated-marketing-endpoint-tripping-required-url-field-guard.md): a
 * same-host, page-load-only capture that no other step references or threads
 * — modeling a marketing/promotions widget firing on page load, generalized to
 * a generic "site-banner" endpoint instead of any real site — must not abort
 * generation just because its own response happens to carry a required *Url
 * field nothing downstream reads.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function noiseCapture(): Capture {
  return {
    timestamp: "2024-01-01T00:00:00.500Z",
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

describe("recon-generate: required-URL-field guard self-heals on an unrelated noise capture", () => {
  it("exits 0 and drops the noise capture's fields when a same-host, unthreaded capture interleaves a real multi-step chain", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-noise-url-guard-"));
    const runRoot = join(workDir, "run");
    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    const allCaptures = [actionCaptures[0]!, noiseCapture(), ...actionCaptures.slice(1)];
    writeRunDir(runRoot, allCaptures);

    const siteId = `recon-noise-url-guard-heal-test-${process.pid}`;
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
  }, 30_000);

  it("still hard-fails when the offending required *Url field's only source is the resolved submit/primary capture itself", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-noise-url-guard-hardfail-"));
    const runRoot = join(workDir, "run");
    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    const last = actionCaptures[actionCaptures.length - 1]!;
    const lastWithUrlField: Capture = {
      ...last,
      responseBody: {
        ...(last.responseBody as Record<string, unknown>),
        confirmationDetailsUrl: "https://api.example.com/confirmation/app-7f3c2e",
      },
    };
    const allCaptures = [...actionCaptures.slice(0, -1), lastWithUrlField];
    writeRunDir(runRoot, allCaptures);

    const siteId = `recon-noise-url-guard-hardfail-test-${process.pid}`;
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
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("confirmationDetailsUrl");
    expect(output).toContain(last.url);
  }, 30_000);
});
