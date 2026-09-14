import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Proves the same-URL/same-method zero-semantic-variance endpoint-collapse
 * guard (`isRedundantSameEndpointGroup`, recon-generate.ts:2315) is
 * structural rather than name-keyed, by exercising the full CLI pipeline
 * against a job-listing/applicant-detail domain whose endpoint paths and
 * field names share zero string vocabulary with any other
 * recon-generate-*.test.ts fixture in this repo.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "roster.unrelated-vocab-fixture.example.net";
const SETTINGS_URL = `https://${OWN_BACKEND_HOST}/prefs/notification-settings`;
const ROSTER_URL = `https://${OWN_BACKEND_HOST}/openings/roster-search/`;
const APPLICANT_URL = `https://${OWN_BACKEND_HOST}/openings/applicant-detail/`;

const SETTINGS_POLL_COUNT = 6;
const ROSTER_PAGE_COUNT = 8;
const APPLICANT_DRILL_COUNT = 6;

function extraResponseFields(prefix: string): Record<string, string> {
  return Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`${prefix}Attribute${i}`, "x"]));
}

function unrelatedVocabularyCaptures(): Capture[] {
  const settings = Array.from({ length: SETTINGS_POLL_COUNT }, (_, i) =>
    buildCapture({
      url: SETTINGS_URL,
      requestPostData: "[]",
      responseBody: { digestEnabled: true, ...extraResponseFields("setting") },
      timestamp: `2024-02-01T00:00:${String(i).padStart(2, "0")}Z`,
    })
  );

  const roster = Array.from({ length: ROSTER_PAGE_COUNT }, (_, i) =>
    buildCapture({
      url: `${ROSTER_URL}?_=${1800000000 + i}`,
      requestPostData: JSON.stringify({ pageIndex: i + 1, resultCap: 20 }),
      responseBody: {
        totalResultPages: ROSTER_PAGE_COUNT,
        openings: [{ openingRef: `r${i + 1}`, ...extraResponseFields("roster") }],
      },
      timestamp: `2024-02-01T00:01:${String(i).padStart(2, "0")}Z`,
    })
  );

  const applicants = Array.from({ length: APPLICANT_DRILL_COUNT }, (_, i) =>
    buildCapture({
      url: APPLICANT_URL,
      requestPostData: JSON.stringify({ openingRef: `r${i + 1}` }),
      responseBody: {
        candidates: [{ candidateRef: `c${i + 1}`, ...extraResponseFields("applicant") }],
        screeningScore: 1.0,
      },
      timestamp: `2024-02-01T00:02:${String(i).padStart(2, "0")}Z`,
    })
  );

  return [...settings, ...roster, ...applicants];
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

describe("recon-generate CLI — endpoint collapse generalizes to unrelated vocabulary (order-of-magnitude regression)", () => {
  it("collapses repeated same-endpoint captures under a domain with zero fixture-vocabulary overlap", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-endpoint-collapse-unrelated-vocab-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, unrelatedVocabularyCaptures());

    const siteId = `endpoint-collapse-unrelated-vocab-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "load notification preferences" },
          { step: "browse paged opening roster" },
          { step: "sort roster by recency" },
          { step: "select first roster entry" },
          { step: "open applicant detail panel", submitStep: true },
          { step: "confirm applicant detail summary" },
        ],
        submitEndpointPattern: "applicant-detail",
        requireSubmitEndpointMatch: true,
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
    const httpClientCallCount = (contract.match(/await httpClient\(/g) ?? []).length;

    // Raw capture count is 20 (6 settings polls + 8 roster pages + 6
    // applicant drills). The collapse guard should emit one call per
    // distinct real endpoint group (settings/roster/applicant), not one
    // hardcoded call per raw capture.
    expect(httpClientCallCount).toBeLessThanOrEqual(5);

    const lineCount = contract.split("\n").length;
    expect(lineCount).toBeGreaterThanOrEqual(200);
    expect(lineCount).toBeLessThanOrEqual(900);
  }, 30_000);
});
