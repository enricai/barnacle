import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Regression test for the false-positive diagnosis in the bug report: recon-generate
 * read 535 files from 7 intermixed runs as if they were one. `readJsonDir` (recon-shared.ts)
 * swallows a wrong/missing dir into `[]` rather than throwing, so a broken run-dir wiring
 * would pass this test vacuously if it only asserted run B's absence — every assertion
 * below also requires run A's data to be present.
 *
 * Exercises the real CLI (`tsx src/scripts/recon-generate.ts --run-dir <path>`) rather than
 * importing `main()` directly, since `main` is not exported and the four read sites
 * (graphql captures, replays, replays/rate-limit.json, aux fixtures) are only reachable
 * through it.
 *
 * recon-summarize.ts has a near-identical read block (recon-shared.ts:87's `readJsonDir`
 * consumers) that is NOT covered here — this subtask's file scope is recon-generate only.
 * If recon-generate's read sites get parameterized through the run-dir seam but
 * recon-summarize's don't, the two will diverge silently.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const capture = (marker: string) => ({
  timestamp: "2024-01-01T00:00:00Z",
  phase: "action",
  method: "POST",
  url: "https://example.com/api/search",
  status: 200,
  requestHeaders: { "Content-Type": "application/json" },
  requestPostData: "{}",
  responseHeaders: {},
  responseBody: { marker },
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
});

const replay = (marker: string) => ({
  sourceCapture: "000-home-action.json",
  url: "https://example.com/api/search",
  method: "POST",
  operationName: null,
  requestBody: "{}",
  replayStatus: 200,
  replayHeaders: {},
  replayBody: { marker },
  success: true,
  error: null,
});

/** Builds one recon run root with a capture/replay/aux fixture all tagged with `marker`. */
function writeRunDir(root: string, marker: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  writeFileSync(join(root, "graphql", "000-home-action.json"), JSON.stringify(capture(marker)));
  writeFileSync(join(root, "replays", "000-home-action.json"), JSON.stringify(replay(marker)));
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  writeFileSync(join(root, "aux", `${marker}.json`), JSON.stringify({ marker }));
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate reads a single run's directory, not a mixed one", () => {
  it("run B's capture/replay/aux artifacts never appear when generating from run A", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-run-input-"));
    const runA = join(workDir, "runA");
    const runB = join(workDir, "runB");
    writeRunDir(runA, "RUN_A_MARKER");
    writeRunDir(runB, "RUN_B_MARKER");

    const siteId = `recon-run-input-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runA, "--emit", "ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const fixtureFiles = readdirSync(join(siteOutDir, "fixtures"));
    const fixtureContents = fixtureFiles.map((f) =>
      readFileSync(join(siteOutDir!, "fixtures", f), "utf8")
    );
    const generatedFiles = [
      contract,
      readFileSync(join(siteOutDir, "flows", "browser-flow.ts"), "utf8"),
      readFileSync(join(siteOutDir, "index.ts"), "utf8"),
      ...fixtureContents,
    ];

    // Run A's data made it into the generated output (a wrong/missing run dir would
    // silently pass an absence-only check, since readJsonDir swallows read errors into []).
    expect(contract).toContain("RUN_A_MARKER");
    expect(fixtureFiles).toContain("RUN_A_MARKER.json");
    expect(fixtureContents.some((c) => c.includes("RUN_A_MARKER"))).toBe(true);

    // Run B's sibling artifacts never leak into any loaded collection or generated file.
    expect(fixtureFiles).not.toContain("RUN_B_MARKER.json");
    for (const content of generatedFiles) {
      expect(content).not.toContain("RUN_B_MARKER");
    }
  }, 30_000);
});
