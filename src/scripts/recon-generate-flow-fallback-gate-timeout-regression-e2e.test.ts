import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Regression pin for the recon-flow.json-declared `browserFallbackGate` /
 * `httpTimeoutMs` keys reaching the TS-generated `contract.ts` (added
 * alongside {@link import("@/scripts/recon-generate").parseFallbackGateSpec}).
 * Unlike `recon-generate-fallback-gate-emission-e2e.test.ts`'s substring
 * assertions, the omission case here diffs the FULL generated file,
 * byte-for-byte, against the pre-change generator (git ref `79f5c52`, the
 * last commit before the fallback-gate feature landed) — so any stray
 * whitespace, ordering, or formatting drift introduced anywhere else in
 * `emitContractTs` by this feature would surface here even if it never
 * touches the `browserFallbackGate`/`defaultTimeoutMs` fragments themselves.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CURRENT_GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const PRE_CHANGE_REF = "79f5c52";

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  writeFileSync(
    join(root, "graphql", "000-search.json"),
    JSON.stringify({
      timestamp: "2024-01-01T00:00:00Z",
      phase: "home",
      method: "POST",
      url: "https://example.com/api/search",
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({ query: "widgets" }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { id: "abc", active: true },
      operationName: null,
      query: null,
      variables: null,
      decodedParams: null,
    })
  );
}

function runGenerate(
  generateScript: string,
  runRoot: string,
  siteId: string
): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [generateScript, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

let workDir: string | null = null;
let siteOutDirs: string[] = [];
let preChangeScriptDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  for (const dir of siteOutDirs) rmSync(dir, { recursive: true, force: true });
  if (preChangeScriptDir) rmSync(preChangeScriptDir, { recursive: true, force: true });
  workDir = null;
  siteOutDirs = [];
  preChangeScriptDir = null;
});

describe("recon-generate CLI regression: recon-flow.json fallback-gate/timeout keys", () => {
  it("emits meta.browserFallbackGate and defaultTimeoutMs when a fixture declares the new keys", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-fallback-gate-timeout-regression-declared-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `fallback-gate-timeout-regression-declared-test-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    siteOutDirs.push(siteOutDir);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search for widgets" }],
        browserFallbackGate: ["HttpServerError", "HttpTimeoutError"],
        httpTimeoutMs: 6000,
      })
    );

    const result = runGenerate(CURRENT_GENERATE_SCRIPT, runRoot, siteId);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain(
      `browserFallbackGate: (error) => ["HttpServerError","HttpTimeoutError"].includes(error.name),`
    );
    expect(contract).toContain("defaultTimeoutMs: 6000");
  }, 30_000);

  it("produces a contract.ts byte-identical to the pre-feature generator when the keys are omitted", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-fallback-gate-timeout-regression-omit-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const flowFile = { steps: [{ step: "search for widgets" }] };

    // Same siteId for both runs, so the generated identifiers (class names,
    // comments, etc.) are identical and only genuine generator-behavior
    // differences can produce a diff. Each run's contract.ts is copied out
    // before the next run overwrites the shared src/sites/<siteId> dir.
    const siteId = `fallback-gate-timeout-regression-omit-test-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    siteOutDirs.push(siteOutDir);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(join(siteOutDir, "recon-flow.json"), JSON.stringify(flowFile));

    const currentResult = runGenerate(CURRENT_GENERATE_SCRIPT, runRoot, siteId);
    expect(currentResult.status, `${currentResult.stdout}\n${currentResult.stderr}`).toBe(0);
    const currentContract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // Pre-feature generator's output, from the last commit before
    // browserFallbackGate/httpTimeoutMs parsing was introduced.
    preChangeScriptDir = mkdtempSync(
      join(REPO_ROOT, "src", "scripts", ".pre-change-fallback-gate-")
    );
    const preChangeScript = join(preChangeScriptDir, "recon-generate.ts");
    const preChangeSource = spawnSync(
      "git",
      ["show", `${PRE_CHANGE_REF}:src/scripts/recon-generate.ts`],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }
    );
    expect(preChangeSource.status, preChangeSource.stderr).toBe(0);
    expect(preChangeSource.stdout).not.toContain("browserFallbackGate");
    writeFileSync(preChangeScript, preChangeSource.stdout);

    const preChangeResult = runGenerate(preChangeScript, runRoot, siteId);
    expect(preChangeResult.status, `${preChangeResult.stdout}\n${preChangeResult.stderr}`).toBe(0);
    const preChangeContract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    expect(currentContract).toBe(preChangeContract);
    expect(currentContract).not.toContain("browserFallbackGate");
    expect(currentContract).not.toContain("defaultTimeoutMs");
  }, 30_000);
});
