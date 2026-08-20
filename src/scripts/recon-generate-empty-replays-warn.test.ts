import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * F1 bonus: an empty replays/ dir means Phase 2/3 (rate-limit probe, replay
 * validation) never ran, yet recon-generate previously emitted a contract
 * silently. This asserts a logger.warn/stderr signal fires at generation time
 * so an operator can't ship an unvalidated contract without seeing it flagged.
 *
 * Exercises the real CLI (`tsx recon-generate.ts`), matching
 * recon-generate-empty-capture-guard.test.ts.
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

const replay = () => ({
  timestamp: "2024-01-01T00:00:01Z",
  phase: "replay",
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

/** A run dir with a capture but an empty replays/ — the case this guard warns on. */
function writeEmptyReplaysRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "graphql", "000-home-action.json"), JSON.stringify(capture()));
}

/** A run dir with a non-empty replays/ — the "no warning" control. */
function writeNonEmptyReplaysRunDir(root: string): void {
  writeEmptyReplaysRunDir(root);
  writeFileSync(join(root, "replays", "000-home-action.json"), JSON.stringify(replay()));
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function run(runRoot: string, siteId: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

describe("recon-generate empty-replays warning (F1 bonus)", () => {
  it("warns on stderr when replays/ is empty, naming the skipped probe", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-empty-replays-"));
    const runRoot = join(workDir, "run");
    writeEmptyReplaysRunDir(runRoot);

    const siteId = `empty-replays-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).toContain("replays");
    expect(out).toContain("recon:http");
  }, 30_000);

  it("does not warn when replays/ has entries (non-empty control)", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-nonempty-replays-"));
    const runRoot = join(workDir, "run");
    writeNonEmptyReplaysRunDir(runRoot);

    const siteId = `nonempty-replays-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).not.toContain("empty replays/");
  }, 30_000);
});
