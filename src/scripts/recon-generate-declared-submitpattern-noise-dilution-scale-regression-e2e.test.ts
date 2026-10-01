import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Scale regression for the "declared submitEndpointPattern (0 capture(s))"
 * defect at real-archive volume/density: extractActionSequence
 * (recon-generate.ts:2325-2344) drops every GET capture that doesn't match a
 * declared foldReturn endpointPattern BEFORE the declared-submitEndpointPattern
 * exemption (recon-generate.ts:2314-2317, 2392-2404) ever gets a chance to
 * admit it — the exemption only ever reaches a capture that already survived
 * the method gate. A real submission step fired as a GET (a search/listing
 * endpoint, as in the reported archive's `available-sailings`) is exactly
 * this shape: it matches the declared submitEndpointPattern but carries no
 * declared foldReturn, so it is dropped at the top of the pipeline and every
 * one of its real matches reads as "0 capture(s)" despite the archive
 * genuinely containing 16 of them scattered among ~4693 total captures — the
 * same ratio the report measured. The small-scale POST-only siblings
 * recon-generate-declared-submit-pattern-real-matches-amid-noise-regression-e2e.test.ts
 * and recon-generate-noisy-archive-submit-pattern-match-not-undercounted-e2e.test.ts
 * never exercise this GET-shaped path, so they pass without covering it.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.noise-dilution-scale-fixture.example.com";
const CONFIRMATION_TOKEN = "RESERVATION-CONFIRM-TOKEN";

const TOTAL_CAPTURES = 4693;
const GENUINE_COUNT = 16;

function fixtureCaptures(): Capture[] {
  // Genuine GET captures matching the declared submitEndpointPattern below,
  // scattered/interleaved throughout the archive (not clustered together) to
  // mirror a real recon run where the submission-equivalent search step
  // fires at arbitrary points across a long session. The surrounding noise
  // is POST-only so the genuine captures' GET method is the only thing that
  // distinguishes them from "page chrome" by shape.
  const genuineIndices = new Set<number>();
  const stride = Math.floor(TOTAL_CAPTURES / GENUINE_COUNT);
  for (let i = 0; i < GENUINE_COUNT; i += 1) {
    genuineIndices.add(i * stride + 7);
  }

  const captures: Capture[] = [];
  let genuineSeq = 0;
  for (let index = 0; index < TOTAL_CAPTURES; index += 1) {
    const timestamp = `2026-05-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
      index % 60
    ).padStart(2, "0")}Z`;
    captures.push(
      genuineIndices.has(index)
        ? buildCapture({
            method: "GET",
            url: `https://${OWN_BACKEND_HOST}/reservations/available-sailings/${genuineSeq}/`,
            requestPostData: null,
            responseBody: { ok: true, confirmationToken: `${CONFIRMATION_TOKEN}-${genuineSeq++}` },
            timestamp,
          })
        : buildCapture({
            url: `https://${OWN_BACKEND_HOST}/catalog/listing-detail-${index}/`,
            requestPostData: JSON.stringify({ page: index }),
            responseBody: { items: [] },
            timestamp,
          })
    );
  }
  return captures;
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(4, "0")}-capture.json`),
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

describe("recon-generate CLI — declared submitEndpointPattern survives thousands of noise captures", () => {
  it("reports the real genuine capture count, not a spurious 0-capture(s) disagreement, at production scale", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-noise-dilution-scale-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `noise-dilution-scale-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search available sailings", submitStep: true }],
        submitEndpointPattern: "available-sailings",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combinedOutput).toBe(0);
    // The genuine, declared-pattern-matching submission count must never
    // read as "(0 capture(s))" when 16 real matches exist among ~4693
    // total captures.
    expect(combinedOutput).not.toContain(
      "declared submitEndpointPattern/submitBodyPattern (0 capture(s))"
    );

    // Pin the actual patternedHeuristicActionCaptures count surfaced in the
    // "submission selection" log line, not just the absence of the literal
    // "(0 capture(s))" string — a log-format change could otherwise mask a
    // real 0-count regression while still passing the string-exclusion check.
    const submissionSelectionLine = combinedOutput
      .split("\n")
      .find((line) => line.includes("submission selection:"));
    expect(submissionSelectionLine, combinedOutput).toBeDefined();
    const capturedCountMatch = submissionSelectionLine?.match(
      /submitEndpointPattern\/submitBodyPattern \((\d+) capture\(s\)\)/
    );
    expect(capturedCountMatch, submissionSelectionLine).not.toBeNull();
    const patternedHeuristicActionCaptures = Number(capturedCountMatch?.[1]);
    expect(patternedHeuristicActionCaptures).toBeGreaterThan(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("available-sailings");
  }, 240_000);
});
