import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression pin for the same under-match shape as
 * recon-generate-multiendpoint-e2e.test.ts's fixture, but checked at the
 * process boundary and the emitted contract.ts. A declared
 * submitEndpointPattern is authoritative even though it under-covers the
 * unfiltered heuristic sequence: the pattern's own narrower match wins,
 * generation still exits 0, the gap is only named in a log line, and there
 * is no self-heal back to the full 8-capture wizard sequence.
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

    // Declared pattern matches only the address and contact sections,
    // under-covering the fixture's other 6 genuine same-host action captures.
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "fill out applicant, address, contact, employment, and attachment sections" },
          { step: "submit address section", submitStep: true },
        ],
        submitEndpointPattern: "/address$|/contact$",
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    // The gap is still named for visibility, but it is only a log line now —
    // the declared pattern is never overridden by the richer unfiltered
    // sequence, so this must not read as the terminal outcome.
    expect(output).toMatch(
      /submitEndpointPattern.*\(2 capture\(s\)\).*undercount.*\(8 capture\(s\)\)/
    );

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The declared pattern's own narrower match wins: only the address and
    // contact captures the pattern matched are emitted, never the
    // unfiltered 8-capture wizard sequence it under-covers.
    expect(contract).toContain("/address");
    expect(contract).toContain("/contact");
    // "/applicant" alone false-positives against the unrelated
    // "applicant-payload" schema import present in every generated
    // contract, so match the call-site shape instead.
    expect(contract).not.toContain("BaseUrl}/applicant");
    expect(contract).not.toContain("/employment");
    expect(contract).not.toContain("/attachments");
    expect(contract).not.toContain("/validate");
  }, 30_000);
});
