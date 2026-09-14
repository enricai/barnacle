import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Exercises identifyNoiseCapturesForFields / isSamePathFamily
 * (src/scripts/recon-generate.ts:11039, isSamePathFamily imported at line 43)
 * against domain vocabulary the guard was never fixture-shaped against: a
 * job-board host with a same-host, fixed-query, zero-per-call-variance
 * telemetry heartbeat beacon, rather than the report's own literal strings.
 */

const OWN_BACKEND_HOST = "www.own-backend-beacon-noise-unrelated-vocab-fixture.example.com";
const LISTING_URL = `https://${OWN_BACKEND_HOST}/open-roles/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/role-detail/`;
const BEACON_URL = `https://${OWN_BACKEND_HOST}/telemetry/heartbeat/nQ4zRk-mLp2/pulse.gif?source=CAREERS.WEB&stage=PROD`;

const LISTING_PAGE_COUNT = 6;
const DETAIL_ITEM_COUNT = 5;
const BEACON_FIRE_COUNT = 14;

function beaconNoiseFixtureCaptures(): Capture[] {
  const listing = Array.from({ length: LISTING_PAGE_COUNT }, (_, i) =>
    buildCapture({
      url: `${LISTING_URL}?_=${1800000000 + i}`,
      requestPostData: JSON.stringify({ page: i + 1 }),
      responseBody: { roles: [{ roleId: `r${i + 1}` }] },
      timestamp: `2024-02-01T00:01:${String(i).padStart(2, "0")}Z`,
    })
  );

  const details = Array.from({ length: DETAIL_ITEM_COUNT }, (_, i) =>
    buildCapture({
      url: DETAIL_URL,
      requestPostData: JSON.stringify({ roleId: `r${i + 1}` }),
      responseBody: { title: `Role ${i + 1}` },
      timestamp: `2024-02-01T00:02:${String(i).padStart(2, "0")}Z`,
    })
  );

  // Same-host, fixed query, zero real request variance — but a distinct
  // fingerprint in the body every fire, so it can't be excluded via
  // byte-identical-body matching alone.
  const beacon = Array.from({ length: BEACON_FIRE_COUNT }, (_, i) =>
    buildCapture({
      url: BEACON_URL,
      requestPostData: `beat=${i}-${Math.random().toString(36).slice(2)}`,
      method: "POST",
      responseBody: {},
      timestamp: `2024-02-01T00:03:${String(i).padStart(2, "0")}Z`,
    })
  );

  return [...listing, ...details, ...beacon];
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

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — beacon noise-exclusion guard against unrelated domain vocabulary", () => {
  it("excludes the fixed-query heartbeat beacon or emits it as one exact literal with no interpolation", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-beacon-noise-unrelated-vocab-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, beaconNoiseFixtureCaptures());

    const siteId = `beacon-noise-unrelated-vocab-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse paged role listing" },
          { step: "select first listed role" },
          { step: "open role detail panel", submitStep: true },
          { step: "confirm role detail summary" },
        ],
        submitEndpointPattern: "role-detail",
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

    const beaconPathOccurrences = (
      contract.match(/telemetry\/heartbeat\/nQ4zRk-mLp2\/pulse\.gif/g) ?? []
    ).length;

    // The opaque beacon path must be either fully absent from the emitted
    // contract, or present as exactly one unparameterized literal — never
    // interpolated (which would indicate a spliced-in field value) and
    // never duplicated per-call.
    if (beaconPathOccurrences === 0) {
      expect(beaconPathOccurrences).toBe(0);
    } else {
      expect(beaconPathOccurrences).toBe(1);
      const beaconLineMatch = contract
        .split("\n")
        .find((line) => line.includes("telemetry/heartbeat/nQ4zRk-mLp2/pulse.gif"));
      expect(beaconLineMatch).toBeDefined();
      expect(beaconLineMatch).not.toContain("${");
    }
  }, 30_000);
});
