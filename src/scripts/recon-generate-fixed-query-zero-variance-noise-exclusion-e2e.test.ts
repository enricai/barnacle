import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildSessionHeartbeatNoiseStep } from "@/scripts/recon-generate-multicall-fixture";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Required item 3 from the recon report: a same-host, fixed-query,
 * zero-request-variance page-load-chrome-style capture (no compound or
 * repeated path segment, no `*Url`-suffixed response field) must be
 * excluded from the generated contract on the FIRST generation pass, purely
 * via the engine's existing site-agnostic mechanisms — never a hardcoded
 * per-endpoint special case, and never by needing a self-heal WARN retry
 * (the required-URL-field guard this fixture is deliberately shaped to
 * never trigger, since it carries no `*Url` field to attribute).
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

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

describe("recon-generate: fixed-query zero-variance non-API noise is excluded without a *Url-field self-heal trigger", () => {
  it("excludes the session-heartbeat capture on the first generation pass", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-fixed-query-zero-variance-noise-"));
    const runRoot = join(workDir, "run");

    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    const noiseCapture = buildSessionHeartbeatNoiseStep("2024-01-01T00:00:00.500Z").capture;

    const noisePath = new URL(noiseCapture.url).pathname;
    const body = noiseCapture.responseBody as Record<string, unknown>;
    expect(Object.keys(body).some((key) => key.endsWith("Url"))).toBe(false);
    expect(noisePath.split("/").filter(Boolean)).toHaveLength(1);

    const submitCapture = actionCaptures[actionCaptures.length - 1]!;
    const submitPath = new URL(submitCapture.url).pathname;
    const allCaptures = [...actionCaptures, noiseCapture];
    writeRunDir(runRoot, allCaptures);

    const siteId = `fixed-query-zero-variance-noise-e2e-test-${process.pid}`;
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
    expect(result.stderr).not.toMatch(/WARN.*self-heal/i);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain(noisePath);
    expect(contract).not.toContain("alive");
    expect(contract).not.toContain("intervalMs");
    expect(contract).toContain(submitPath);
  }, 30_000);
});
