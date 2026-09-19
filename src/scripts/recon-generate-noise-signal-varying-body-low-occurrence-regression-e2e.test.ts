import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isZeroVarianceRepeatCapture } from "@/recon/capture-filters";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Reproduces the follow-up regression on the varying-body/explicit-content-type
 * branch of `isZeroVarianceRepeatCapture` (capture-filters.ts:740-754): a
 * same-origin, query-less noise widget whose POST body differs on every
 * occurrence (a fingerprint/nonce field) and whose response carries an
 * explicit content-type header still broke fold-plan primary-operation
 * selection with `emitContractTs: fold plan primary operation ... differs
 * from the emitted primary operation` when it fired only 7 times, below the
 * previously hardcoded 10-occurrence floor. The existing low-occurrence e2e
 * file only exercises the body-IDENTICAL branch (capture-filters.ts:723-738);
 * this proves the fix also holds on the varying-body branch, end to end
 * through recon-generate.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

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

describe("recon noise admission at low occurrence scale: same-origin widget with a varying POST body firing only 7 times", () => {
  it("emits the real search/drill endpoints and never the noise endpoint when the varying-body noise widget fires only 7 times", () => {
    const OWN_BACKEND_HOST = "www.noise-varying-body-fixture.example.com";
    const SEARCH_URL = `https://${OWN_BACKEND_HOST}/catalog-search/`;
    const DRILL_URL = `https://${OWN_BACKEND_HOST}/catalog-detail/`;

    // Same-origin, queryless, fixed-shape widget noise, firing at the exact
    // count the reported regression captured on a live run (7), which fell
    // below the since-removed 10-occurrence floor.
    const SAME_ORIGIN_NOISE_URL = `https://${OWN_BACKEND_HOST}/urgency-ping`;

    workDir = mkdtempSync(join(tmpdir(), "barnacle-noise-varying-body-"));
    const runRoot = join(workDir, "run");

    const search = buildCapture({
      url: SEARCH_URL,
      requestPostData: JSON.stringify({ q: "widgets" }),
      responseBody: { results: [{ id: "item-1" }, { id: "item-2" }] },
      timestamp: "2026-01-01T00:00:00Z",
    });
    const drill = buildCapture({
      url: DRILL_URL,
      requestPostData: JSON.stringify({ id: "item-1" }),
      responseBody: { detail: { id: "item-1", price: 42 } },
      timestamp: "2026-01-01T00:00:01Z",
    });

    let secondsCursor = 2;
    const nextTimestamp = (): string =>
      `2026-01-01T00:00:${String(secondsCursor++).padStart(2, "0")}Z`;

    // 7 same-origin widget noise captures — the exact occurrence count from
    // the reported live-site repro, well above MIN_QUERYLESS_REPEAT_COUNT but
    // below the removed 10x floor. Each occurrence sends a per-call-varying
    // POST body (a fresh nonce field) rather than an identical one, and each
    // response carries an explicit json content-type header — the shape that
    // routes through capture-filters.ts's varying-body branch
    // (isZeroVarianceRepeatCapture's `!queryLessBodyIdentical` path) rather
    // than the already-covered body-identical branch. The response body
    // itself stamps a fresh, business-looking (non-URL-derivable) id on every
    // occurrence, exercising `hasFreelyVaryingResponseAcrossOccurrences`.
    const sameOriginNoise: Capture[] = Array.from({ length: 7 }, (_, i) =>
      buildCapture({
        url: SAME_ORIGIN_NOISE_URL,
        requestPostData: JSON.stringify({ nonce: `nonce-${i}-${Math.random()}` }),
        responseBody: { impressionId: `imp-${i}-${Math.random()}` },
        responseHeaders: { "content-type": "application/json" },
        timestamp: nextTimestamp(),
      })
    );

    const allCaptures = [search, drill, ...sameOriginNoise];
    expect(allCaptures).toHaveLength(9);

    // Pin the predicate directly at the reported scale before running the
    // full pipeline: the noise widget must be excluded, and the real search
    // capture must not be swept in merely for sharing a host.
    expect(isZeroVarianceRepeatCapture(sameOriginNoise[0]!, allCaptures)).toBe(true);
    expect(isZeroVarianceRepeatCapture(search, allCaptures)).toBe(false);

    writeRunDir(runRoot, allCaptures);

    const siteId = `noise-varying-body-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search catalog" }, { step: "view item detail", submitStep: true }],
        submitEndpointPattern: "catalog-detail",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = runGenerate(siteId, runRoot);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    expect(contract).toContain("catalog-search/");
    expect(contract).toContain("catalog-detail/");
    expect(contract).not.toContain("urgency-ping");
  });
});
