import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function generate(url: string): string {
  const workDir = mkdtempSync(join(tmpdir(), "barnacle-single-get-"));
  dirs.push(workDir);
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  writeFileSync(
    join(capturesDir, "000-read.json"),
    JSON.stringify(
      buildCapture({
        url,
        requestPostData: null,
        responseBody: { id: 1, name: "widget" },
        timestamp: "2024-02-01T00:00:00Z",
        method: "GET",
      })
    )
  );
  const siteId = `single-get-emit-test-${process.pid}-${dirs.length}`;
  const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  dirs.push(siteOutDir);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({ steps: [{ step: "open the page" }, { step: "view the item" }] })
  );
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

describe("recon-generate — single GET winner emission", () => {
  it("path-segment inputs: GET, no query field, no job tracking", () => {
    const contract = generate("https://api.example.com/v2/boards/acme/jobs/12345");
    expect(contract).toContain('method: "GET"');
    expect(contract).not.toContain('method: "POST"');
    expect(contract).not.toMatch(/query: z\.string/);
    expect(contract).not.toContain("JobTracking");
  }, 60_000);

  it("no inferable inputs: GET of the recorded URL, no query field, no job tracking", () => {
    const contract = generate("https://api.example.com/v2/jobs");
    expect(contract).toContain('method: "GET"');
    expect(contract).not.toContain('method: "POST"');
    expect(contract).not.toMatch(/query: z\.string/);
    expect(contract).not.toContain("JobTracking");
  }, 60_000);
});
