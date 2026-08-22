import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end pin at the CLI boundary: a flow-authored `displayName` in
 * recon-flow.json's object form must reach both generated-plugin emit
 * paths — the `.ts` contract's `meta` block and the `--emit config`
 * manifest's `metadata` object — with no siteId-derived fallback when the
 * field is absent.
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

function run(runRoot: string, siteId: string, emit: "ts" | "config"): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", emit, "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

describe("recon-generate CLI e2e: flow-authored displayName reaches both emit paths", () => {
  it("threads recon-flow.json's displayName into contract.ts's meta block", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-displayname-ts-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `recon-displayname-ts-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ steps: [{ step: "search for widgets" }], displayName: "Acme Widgets" })
    );

    const result = run(runRoot, siteId, "ts");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain(`displayName: "Acme Widgets"`);
  }, 30_000);

  it("threads recon-flow.json's displayName into the config manifest's metadata", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-displayname-config-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `recon-displayname-config-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ steps: [{ step: "search for widgets" }], displayName: "Acme Widgets" })
    );

    const result = run(runRoot, siteId, "config");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const manifest = JSON.parse(
      readFileSync(join(siteOutDir, `${siteId}.plugin.json`), "utf8")
    ) as { metadata: Record<string, unknown> };
    expect(manifest.metadata.displayName).toBe("Acme Widgets");
  }, 30_000);

  it("omits displayName from both outputs when recon-flow.json has no such field", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-displayname-omit-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `recon-displayname-omit-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ steps: [{ step: "search for widgets" }] })
    );

    const tsResult = run(runRoot, siteId, "ts");
    expect(tsResult.status, `${tsResult.stdout}\n${tsResult.stderr}`).toBe(0);
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain("displayName");

    const configResult = run(runRoot, siteId, "config");
    expect(configResult.status, `${configResult.stdout}\n${configResult.stderr}`).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(siteOutDir, `${siteId}.plugin.json`), "utf8")
    ) as { metadata: Record<string, unknown> };
    expect(manifest.metadata).not.toHaveProperty("displayName");
  }, 30_000);
});
