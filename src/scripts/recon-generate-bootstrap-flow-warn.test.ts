import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Diagnostic for FAILURE 3 (a flowless recon capture): recon:generate presented three
 * landing-page `POST /widgets` bootstrap calls as a "submission flow, 3 steps".
 * We do not filter those out (that would delete the sole search POST of legitimate
 * single-endpoint runs, which is also landing-phase) — instead recon:generate WARNs
 * when a claimed submission flow is entirely landing-phase (`phase="home"`) captures.
 * This asserts the WARN fires for that shape and stays silent for a real walked flow.
 *
 * Exercises the real CLI, mirroring recon-generate-run-input.test.ts, since the
 * diagnostic lives inside the un-exported `main`.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const post = (phase: string, path: string) => ({
  timestamp: "2024-01-01T00:00:00Z",
  phase,
  method: "POST",
  url: `https://example.com${path}`,
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

/** Two distinct same-host 2xx POSTs (so they aren't collapsed) with the given phases. */
function writeRunDir(root: string, phases: [string, string]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "graphql", "000-a.json"), JSON.stringify(post(phases[0], "/widgets")));
  writeFileSync(join(root, "graphql", "001-b.json"), JSON.stringify(post(phases[1], "/widgets2")));
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

describe("recon-generate landing-phase submission-flow WARN (FAILURE 3)", () => {
  it("WARNs when every action capture in a submission flow is landing-phase", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-bootstrap-warn-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, ["home", "home"]);

    const siteId = `bootstrap-warn-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    // Substring is quote-agnostic: JSON log output escapes the inner quotes
    // (phase=\"home\"), pretty output does not — match the stable prefix only.
    expect(out).toContain("action captures are landing-phase");
  }, 30_000);

  it("stays silent when an action capture carries a real step-slug phase", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-bootstrap-warn-quiet-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, ["home", "personal-information"]);

    const siteId = `bootstrap-warn-quiet-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).not.toContain("action captures are landing-phase");
  }, 30_000);
});
