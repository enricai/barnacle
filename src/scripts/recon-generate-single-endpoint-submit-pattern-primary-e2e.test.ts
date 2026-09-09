import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the second half of the root cause behind
 * recon-generate-authoritative-submitendpointpattern-replaces-action-sequence-degrading-multi-call-flow-to-wrong-single-endpoint:
 * once a declared `submitEndpointPattern` legitimately truncates the action
 * sequence down to a true single-endpoint flow, the single-endpoint
 * primary-capture selection (which runs unconditionally, before
 * `isSubmissionFlow` is known) must still honor the declared pattern rather
 * than falling through to a free chronological/scoring heuristic that can
 * pick an unrelated own-backend decoy.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.single-endpoint-pattern-fixture.example.com";

function restCapture(overrides: {
  url: string;
  requestPostData: string;
  responseBody: unknown;
}): Capture {
  return {
    timestamp: "2026-09-09T10:23:03.000Z",
    phase: "home",
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData,
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

/**
 * Two own-backend decoys that fire before the real submission and are
 * excluded from the heuristic action sequence's noise filter (an
 * error-reporting-sink path segment), so the truncated action sequence is a
 * true single-step flow — but they remain visible, host-allowed candidates
 * to the single-endpoint primary-capture selection functions, which apply
 * no noise filter of their own.
 */
function decoyCaptures(): Capture[] {
  return [
    restCapture({
      url: `https://${OWN_BACKEND_HOST}/api/errors/toggle-a`,
      requestPostData: JSON.stringify({ toggle: "a" }),
      responseBody: { toggled: true, decoy: "a" },
    }),
    restCapture({
      url: `https://${OWN_BACKEND_HOST}/api/errors/toggle-b`,
      requestPostData: JSON.stringify({ toggle: "b" }),
      responseBody: { toggled: true, decoy: "b" },
    }),
  ];
}

/** The single capture the declared pattern matches — the real search endpoint. */
function patternMatchedCapture(): Capture {
  return restCapture({
    url: `https://${OWN_BACKEND_HOST}/api/search-final`,
    requestPostData: JSON.stringify({ query: "widgets" }),
    responseBody: { results: [{ id: 1 }] },
  });
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

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — single-endpoint primary selection honors a declared submitEndpointPattern", () => {
  it("emits the pattern-matched capture as the primary/winning capture, never an earlier own-backend decoy", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-single-endpoint-submit-pattern-e2e-"));
    const runRoot = join(workDir, "run");
    // Decoys written first so a chronological/scoring-only heuristic would
    // pick a decoy over the declared pattern's match, if the pattern were
    // ignored on this path.
    writeRunDir(runRoot, [...decoyCaptures(), patternMatchedCapture()]);

    const siteId = `single-endpoint-submit-pattern-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search for widgets" }],
        submitEndpointPattern: "/api/search-final$",
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/single-endpoint REST/);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The primary/winning capture traces to the declared pattern's match...
    expect(contract).toContain("/api/search-final");

    // ...never to either earlier own-backend decoy.
    expect(contract).not.toContain("/api/errors/toggle-a");
    expect(contract).not.toContain("/api/errors/toggle-b");
    expect(contract).not.toContain("decoy");
  }, 30_000);
});
