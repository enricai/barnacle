import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * The report's own verification hook for host-provenance gating on the
 * action-sequence path: a run mixing own-backend action POSTs with N
 * interleaved third-party-host 2xx POSTs must select the identical action
 * sequence as the same run with the third-party POSTs removed. Reuses
 * recon-generate-multiendpoint-fixture.ts's own-backend multi-POST sequence
 * (genuine action-step admission, not just deriveBaseUrl's read path) and
 * declares ownBackendHostnames so isAllowedFixtureHost has real provenance
 * data to gate on, matching
 * recon-generate-nongraphql-thirdparty-decoy-host-provenance-e2e.test.ts's
 * decoy-host idiom.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "api.example.com";
const THIRD_PARTY_HOST = "noise.third-party-decoy.example.net";

function thirdPartyPostCapture(index: number, timestamp: string): Capture {
  return {
    timestamp,
    phase: "action",
    method: "POST",
    url: `https://${THIRD_PARTY_HOST}/collect/${index}`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ event: index }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { ok: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function interleaveWithThirdPartyNoise(ownCaptures: Capture[]): Capture[] {
  return ownCaptures.flatMap((capture, index) => [
    thirdPartyPostCapture(index, `2024-01-01T00:10:0${index}Z`),
    capture,
  ]);
}

function writeRunDir(root: string, captures: Capture[]): void {
  const capturesDir = join(root, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
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

describe("recon-generate CLI — third-party 2xx POSTs interleaved with own-backend action POSTs never change the selected action sequence", () => {
  it("selects a byte-for-byte identical contract.ts whether or not third-party-host POSTs are interleaved with the own-backend submission sequence", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-thirdparty-action-sequence-parity-e2e-"));
    const runWithNoise = join(workDir, "run-with-noise");
    const runWithoutNoise = join(workDir, "run-without-noise");

    const ownCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    writeRunDir(runWithNoise, interleaveWithThirdPartyNoise(ownCaptures));
    writeRunDir(runWithoutNoise, ownCaptures);

    const siteId = `thirdparty-action-sequence-parity-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    writeSiteFlow(siteOutDir);
    const resultWithNoise = generate(runWithNoise, siteId);
    expect(resultWithNoise.status, `${resultWithNoise.stdout}\n${resultWithNoise.stderr}`).toBe(0);

    const contractWithNoise = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contractWithNoise).not.toContain(THIRD_PARTY_HOST);

    rmSync(siteOutDir, { recursive: true, force: true });
    writeSiteFlow(siteOutDir);
    const resultWithoutNoise = generate(runWithoutNoise, siteId);
    expect(
      resultWithoutNoise.status,
      `${resultWithoutNoise.stdout}\n${resultWithoutNoise.stderr}`
    ).toBe(0);

    const contractWithoutNoise = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The report's own verification hook: the third-party-host 2xx POSTs
    // interleaved with the real own-backend action sequence must not change
    // which steps are selected, their order, or the emitted contract in any
    // way. The generated contract is fully deterministic from the same
    // siteId/flow/own-backend captures, so byte-for-byte equality is the
    // strongest available check.
    expect(contractWithNoise).toBe(contractWithoutNoise);
  }, 30_000);
});
