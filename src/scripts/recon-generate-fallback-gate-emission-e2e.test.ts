import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end pin at the CLI boundary: recon-flow.json's `browserFallbackGate`
 * / `httpTimeoutMs` declarations must reach the generated `.ts` contract's
 * `meta.browserFallbackGate` literal and `createHttpClient`'s
 * `defaultTimeoutMs`, closing the same 65-86s unconditional-cascade problem
 * for the TS-generated plugin path that config-only manifests are gated
 * against separately.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

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
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

describe("recon-generate CLI e2e: recon-flow.json-declared fallback-gate/timeout reach the TS contract", () => {
  it("emits a list-derived browserFallbackGate predicate and defaultTimeoutMs from declared keys", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-fallback-gate-list-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `recon-fallback-gate-list-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search for widgets" }],
        browserFallbackGate: ["HttpServerError", "HttpRateLimitError"],
        httpTimeoutMs: 4000,
      })
    );

    const result = run(runRoot, siteId);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain(
      `browserFallbackGate: (error) => ["HttpServerError","HttpRateLimitError"].includes(error.name),`
    );
    expect(contract).toContain("defaultTimeoutMs: 4000");
  }, 30_000);

  it("emits a literal false browserFallbackGate when the flow declares it disabled", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-fallback-gate-false-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `recon-fallback-gate-false-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ steps: [{ step: "search for widgets" }], browserFallbackGate: false })
    );

    const result = run(runRoot, siteId);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("browserFallbackGate: false,");
    expect(contract).not.toContain("defaultTimeoutMs");
  }, 30_000);

  it("omits both from the emitted contract when recon-flow.json declares neither key", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-fallback-gate-omit-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `recon-fallback-gate-omit-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ steps: [{ step: "search for widgets" }] })
    );

    const result = run(runRoot, siteId);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain("browserFallbackGate");
    expect(contract).not.toContain("defaultTimeoutMs");
  }, 30_000);
});
