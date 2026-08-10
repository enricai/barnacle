import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Guards FAILURE 2 from the a flowless recon capture: recon-generate accepted an
 * apply-less run dir (empty graphql/) and emitted a skeleton plugin whose
 * "submission flow" was fabricated from landing-page chrome, exiting 0. The fix
 * fails fast on `captures.length === 0` unless `--allow-empty-capture` is passed.
 *
 * Exercises the real CLI (`tsx recon-generate.ts`) rather than importing `main`,
 * which is not exported — mirroring recon-generate-run-input.test.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const capture = () => ({
  timestamp: "2024-01-01T00:00:00Z",
  phase: "action",
  method: "POST",
  url: "https://example.com/api/search",
  status: 200,
  requestHeaders: { "Content-Type": "application/json" },
  requestPostData: "{}",
  responseHeaders: {},
  responseBody: { ok: true },
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
});

/** An empty run dir: the three subdirs exist but graphql/ has no captures. */
function writeEmptyRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
}

/** A run dir with one capture — the "non-empty passes" control. */
function writeNonEmptyRunDir(root: string): void {
  writeEmptyRunDir(root);
  writeFileSync(join(root, "graphql", "000-home-action.json"), JSON.stringify(capture()));
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function run(
  runRoot: string,
  siteId: string,
  extraArgs: string[] = []
): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", ...extraArgs],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

describe("recon-generate empty-capture guard (FAILURE 2)", () => {
  it("exits non-zero with a clear message when graphql/ has no captures", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-empty-capture-"));
    const runRoot = join(workDir, "run");
    writeEmptyRunDir(runRoot);

    const siteId = `empty-capture-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    const result = run(runRoot, siteId);

    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("no captures");
    // Nothing was emitted — the degenerate run never reached the emitter.
    expect(existsSync(siteOutDir)).toBe(false);
  }, 30_000);

  it("--allow-empty-capture bypasses the guard", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-empty-capture-allow-"));
    const runRoot = join(workDir, "run");
    writeEmptyRunDir(runRoot);

    const siteId = `empty-capture-allow-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    const result = run(runRoot, siteId, ["--allow-empty-capture"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(siteOutDir)).toBe(true);
  }, 30_000);

  it("a run with captures passes without the flag (non-empty control)", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-nonempty-capture-"));
    const runRoot = join(workDir, "run");
    writeNonEmptyRunDir(runRoot);

    const siteId = `nonempty-capture-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    const result = run(runRoot, siteId);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(siteOutDir)).toBe(true);
  }, 30_000);
});
