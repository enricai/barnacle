import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * CLI-level regression for
 * docs/recon-generate-nested-fold-flatmaps-away-the-parent-so-drill-params-freeze.md
 * suggested fix #2, exercised end to end through the real `recon-generate`
 * script (rather than the unit-level emitter coverage in
 * recon-generate-frozen-varying-drill-param-hard-fail.test.ts): a run whose
 * own captures drill the SAME endpoint twice with a query param that differs
 * between the two captures, and that neither the joined item nor any
 * ancestor scope explains, must never be silently frozen as a literal in the
 * generated contract — the CLI must name the offending param instead.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function searchCapture(): Capture {
  return {
    timestamp: "2024-04-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: "https://api.example.com/catalog/search/",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ page: 1 }),
    responseHeaders: {},
    responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

/** Two drill captures of the same endpoint, both threading `sku` normally,
 * but each carrying a different `region` value that no threaded field
 * explains — proof the CLI's own captures disprove a frozen literal. */
function drillCapture(sku: string, region: string, amount: number, timestamp: string): Capture {
  return {
    timestamp,
    phase: "browse",
    method: "GET",
    url: `https://api.example.com/catalog/pricing/?sku=${sku}&region=${region}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { results: [{ sku, amount }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function writeRunDir(root: string): void {
  const capturesDir = join(root, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(capturesDir, "000-browse-search.json"), JSON.stringify(searchCapture()));
  writeFileSync(
    join(capturesDir, "001-browse-drill.json"),
    JSON.stringify(drillCapture("sku-a", "us", 19.99, "2024-04-01T00:00:01Z"))
  );
  writeFileSync(
    join(capturesDir, "002-browse-drill.json"),
    JSON.stringify(drillCapture("sku-b", "eu", 24.99, "2024-04-01T00:00:02Z"))
  );
}

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  const flow: Record<string, unknown> = {
    steps: [{ step: "search the catalog" }],
    foldReturn: {
      endpointPattern: "/catalog/pricing/",
      resultsPath: "results",
      joinFields: ["sku"],
    },
  };
  writeFileSync(join(siteOutDir, "recon-flow.json"), JSON.stringify(flow));
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

describe("recon-generate CLI — frozen-but-varying drill param hard fail", () => {
  it("never silently freezes a drill query param the run's own captures prove varies", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-frozen-varying-drill-param-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `frozen-varying-drill-param-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;
    const contractPath = join(siteOutDir, "contract.ts");

    if (result.status !== 0) {
      expect(out).toContain("region");
      expect(existsSync(contractPath)).toBe(false);
      return;
    }

    expect(out).toMatch(/WARN.*region/i);
    const contract = existsSync(contractPath) ? readFileSync(contractPath, "utf8") : "";
    expect(contract).not.toContain("region=us");
    expect(contract).not.toContain("region=eu");
  }, 30_000);
});
