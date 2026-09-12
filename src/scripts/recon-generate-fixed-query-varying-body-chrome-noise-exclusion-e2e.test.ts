import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * A same-host, fixed-query, page-load-chrome endpoint (a session-authenticator
 * beacon: constant `clientId`/`environment` query, HTML response with no
 * business state) whose REQUEST BODY differs on every fire (an embedded
 * fingerprint/nonce) must still be excluded upfront — the fixed query alone
 * identifies it, and the varying body must not defeat that.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const BEACON_URL = "https://api.example.com/auth/responder.html?clientId=TPR-LBJS.WEB&environment=PROD";

function buildBeaconCapture(index: number, timestamp: string): Capture {
  return {
    timestamp,
    phase: "action",
    method: "GET",
    url: BEACON_URL,
    status: 200,
    requestHeaders: {},
    requestPostData: `fingerprint=beacon-${index}-${Math.random().toString(36).slice(2)}`,
    responseHeaders: { "content-type": "text/html" },
    responseBody: "<html><body></body></html>",
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

describe("recon-generate: fixed-query chrome noise with a varying request body is still excluded", () => {
  it("excludes the beacon on the first generation pass even though its body never repeats byte-for-byte", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-fixed-query-varying-body-noise-"));
    const runRoot = join(workDir, "run");

    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    const beaconCaptures = Array.from({ length: 14 }, (_, i) =>
      buildBeaconCapture(i, `2024-01-01T00:00:${String(10 + i).padStart(2, "0")}Z`)
    );
    const bodies = new Set(beaconCaptures.map((c) => c.requestPostData));
    expect(bodies.size).toBe(beaconCaptures.length);

    const submitCapture = actionCaptures[actionCaptures.length - 1]!;
    const submitPath = new URL(submitCapture.url).pathname;
    const allCaptures = [...actionCaptures, ...beaconCaptures];
    writeRunDir(runRoot, allCaptures);

    const siteId = `fixed-query-varying-body-noise-e2e-test-${process.pid}`;
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
    expect(contract).not.toContain("responder.html");
    expect(contract).not.toContain("clientId");
    expect(contract).toContain(submitPath);
  }, 30_000);
});
