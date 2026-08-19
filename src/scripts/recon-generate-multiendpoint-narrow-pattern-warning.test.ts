import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression pin for the same under-match shape as
 * recon-generate-multiendpoint-e2e.test.ts's fixture, but checked at the
 * process boundary only — the explicit matched-vs-total mismatch wording,
 * distinct from that test's contract.ts content assertions. For this
 * fixture the narrow pattern is recoverable (the unfiltered heuristic
 * sequence still finds every section), so recon-generate self-heals to the
 * full sequence instead of hard-failing — but it must still name the
 * capture-count gap out loud rather than silently discarding the pattern.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const LANDING_URL = "https://api.example.com/job/12345/apply";

function landingCapture(): Capture {
  return {
    timestamp: "2023-12-31T23:59:59Z",
    phase: "home",
    method: "GET",
    url: LANDING_URL,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "text/html" },
    responseBody: null,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate: narrow submitEndpointPattern must surface, not silently degrade", () => {
  it("names the matched-vs-total capture gap instead of silently discarding the pattern", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-narrow-pattern-warning-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    const landing = landingCapture();
    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    const allCaptures = [landing, ...actionCaptures];
    allCaptures.forEach((capture, index) => {
      const filename = `${String(index).padStart(3, "0")}-multiendpoint-action.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
    });

    const siteId = `recon-narrow-pattern-warning-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    // Declared pattern matches only the /address section, under-covering the
    // fixture's other 6 genuine same-host action captures.
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "fill out applicant, address, contact, employment, and attachment sections" },
          { step: "submit address section", submitStep: true },
        ],
        submitEndpointPattern: "/address$",
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toMatch(/submitEndpointPattern/);
    // Names the exact matched-vs-total capture counts, not a vague warning.
    expect(output).toMatch(
      /ignoring submitEndpointPattern.*\(1 capture\(s\)\).*undercount.*\(8 capture\(s\)\)/
    );
  }, 30_000);
});
