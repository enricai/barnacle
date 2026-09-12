import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Required item 2 from the recon report: two distinct same-host,
 * fixed-query, zero-request-variance non-API beacon shapes — a
 * feature-flag/toggle-poll beacon (`/status/heartbeat`-style, fired 6x with
 * byte-identical request/response, in both a GET and a POST-fired variant)
 * and a session-authenticator/redirect beacon (`/session/redirect-relay.html`
 * -style opaque path, fired 14x with a fixed query string) — must both be
 * excluded from the generated contract, generalizing the same noise-family
 * mechanism #358/#368 generalized for marketing endpoints.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const TOGGLE_URL = "https://api.example.com/status/heartbeat?clientId=fixed-client";
const RELAY_URL =
  "https://api.example.com/session/redirect-relay.html?clientId=fixed-client&env=prod";

function buildToggleCapture(method: "GET" | "POST", timestamp: string): Capture {
  return {
    timestamp,
    phase: "action",
    method,
    url: TOGGLE_URL,
    status: 200,
    requestHeaders: {},
    requestPostData: method === "POST" ? "" : null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { enabled: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function buildRelayCapture(index: number, timestamp: string): Capture {
  return {
    timestamp,
    phase: "action",
    method: "GET",
    url: RELAY_URL,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "text/html" },
    responseBody: `<html><body>relay-${index}</body></html>`,
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

describe("recon-generate: fixed-query zero-variance toggle-poll and redirect-relay beacons are excluded as noise", () => {
  it("excludes both beacon shapes on the first generation pass for GET and POST toggle variants", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-fixed-query-beacon-noise-"));
    const runRoot = join(workDir, "run");

    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    const toggleCaptures = Array.from({ length: 6 }, (_, i) =>
      buildToggleCapture(
        i % 2 === 0 ? "GET" : "POST",
        `2024-01-01T00:00:${String(10 + i).padStart(2, "0")}Z`
      )
    );
    const relayCaptures = Array.from({ length: 14 }, (_, i) =>
      buildRelayCapture(i, `2024-01-01T00:01:${String(10 + i).padStart(2, "0")}Z`)
    );

    const togglePath = new URL(TOGGLE_URL).pathname;
    const relayPath = new URL(RELAY_URL).pathname;

    const submitCapture = actionCaptures[actionCaptures.length - 1]!;
    const submitPath = new URL(submitCapture.url).pathname;
    const allCaptures = [...actionCaptures, ...toggleCaptures, ...relayCaptures];
    writeRunDir(runRoot, allCaptures);

    const siteId = `fixed-query-beacon-noise-e2e-test-${process.pid}`;
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
    expect(contract).not.toContain(togglePath);
    expect(contract).not.toContain(relayPath);
    expect(contract).toContain(submitPath);
  }, 30_000);
});
