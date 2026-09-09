import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMulticallHeterogeneousActionStepsWithBookingSubmit } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * The bug report's shape: a same-host, multi-step REST submission flow
 * (auth mint -> paged facet search -> availability drill -> terminal POST
 * booking submit) whose captured bodies only ever carry facet/booking
 * fields, never anything job-application-shaped. The reported defect forced
 * ApplicantContactSchema (and its Email/ClickUrl/Answers base fields) onto
 * the emitted payload schema regardless of whether the captured bodies gave
 * any evidence for it. This proves the fix at the CLI boundary the report's
 * "Verification hooks" section names, not just at emitContractTs's unit
 * level.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-non-applicant-submission-fixture.example.com";

/** Rehosts a fixture capture's URL onto the synthetic own-backend host, keeping its path/query. */
function rehostCapture(capture: Capture): Capture {
  const rehostedUrl = new URL(capture.url);
  rehostedUrl.host = OWN_BACKEND_HOST;
  return { ...capture, url: rehostedUrl.toString() };
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

describe("recon-generate CLI — non-applicant multi-step REST submission flow keeps its own payload schema", () => {
  it("never forces ApplicantContactSchema/Email/ClickUrl/Answers onto a facet/booking-only submission flow", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-non-applicant-submission-e2e-"));
    const runRoot = join(workDir, "run");
    const captures = buildMulticallHeterogeneousActionStepsWithBookingSubmit().map((step) =>
      rehostCapture(step.capture)
    );
    writeRunDir(runRoot, captures);

    const siteId = `non-applicant-submission-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "authorize session" },
          { step: "browse paged facet search" },
          { step: "drill into unit availability" },
          { step: "book availability", submitStep: true },
        ],
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The root-cause fix: no applicant-shaped evidence anywhere in the
    // captured bodies means ApplicantContactSchema must never be selected.
    expect(contract).not.toContain("ApplicantContactSchema");
    expect(contract).not.toMatch(/\bEmail:\s*z\.email\(\)/);
    expect(contract).not.toMatch(/\bClickUrl:\s*z\.string\(\)\.min\(1\)/);
    expect(contract).not.toMatch(/\bAnswers:\s*multipartJsonObject/);

    // The flow's own genuinely-threaded facet/booking fields still surface
    // on the payload schema.
    expect(contract).toContain("category");
    expect(contract).toContain("region");
    expect(contract).toContain("checkIn");
    expect(contract).toContain("checkOut");
    expect(contract).toContain("guests");
  }, 30_000);
});
