import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * The report's own verification hook for the required-URL-field guard: a
 * host-gated multi-step action chain interleaved with one unrelated
 * same-host, page-load-only capture (modeling a promo/analytics widget, not
 * any real site or vendor) whose response carries required *Url-family
 * fields nothing downstream threads must still generate successfully, and
 * the noise capture's fields and host-path must never leak into the emitted
 * contract. Follows recon-generate-thirdparty-action-sequence-parity-
 * e2e.test.ts's spawnSync-against-recon-generate.ts idiom, but keeps the
 * noise capture on the SAME host as the real chain (declared via
 * ownBackendHostnames) rather than a third-party host, since that is the
 * specific gap this defect exposes.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "api.example.com";
const NOISE_PATH = "/promo-widget";

function noiseCapture(timestamp: string): Capture {
  return {
    timestamp,
    phase: "home",
    method: "GET",
    url: `https://${OWN_BACKEND_HOST}${NOISE_PATH}`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      promoImageUrl: "https://cdn.example.com/promo.png",
      promoTargetUrl: "https://cdn.example.com/promo-landing",
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
    writeFileSync(
      join(capturesDir, `${String(index).padStart(3, "0")}-capture.json`),
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
      ownBackendHostnames: [OWN_BACKEND_HOST],
    })
  );
}

function generate(runRoot: string, siteId: string): ReturnType<typeof spawnSync> {
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

describe("recon-generate CLI — an unrelated same-host noise capture with a required *Url field never aborts generation or leaks into the contract", () => {
  it("exits 0 and the emitted contract.ts is free of the noise capture's fields and host-path", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-marketing-endpoint-noise-guard-e2e-"));
    const runRoot = join(workDir, "run");

    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    const allCaptures = [
      actionCaptures[0]!,
      noiseCapture("2024-01-01T00:00:00.500Z"),
      ...actionCaptures.slice(1),
    ];
    writeRunDir(runRoot, allCaptures);

    const siteId = `marketing-endpoint-noise-guard-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeSiteFlow(siteOutDir);

    const result = generate(runRoot, siteId);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain("promoImageUrl");
    expect(contract).not.toContain("promoTargetUrl");
    expect(contract).not.toContain(NOISE_PATH);
  }, 30_000);
});
