import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Regression test for the report's exact scenario: aux captures that share
 * the flow's own-backend host but are structurally unrelated to it (e.g. a
 * locale-string dictionary and a feature-toggle resolver, versus a generic
 * booking/search flow) must never land in the generated plugin's committed
 * fixtures/ directory, and must never be referenced uncommented in
 * contract.ts. Same-host provenance alone is not a reason to copy a capture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_HOST = "api.example.com";

function flowCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "home",
    method: "GET",
    url: `https://${OWN_HOST}/search-results`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { results: [{ id: "1", name: "Result One" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate: same-host but unrelated aux captures never land in fixtures/", () => {
  it("omits fixtures/ and any uncommented reference to unrelated own-backend aux captures", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-aux-unrelated-omission-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    const auxDir = join(runRoot, "aux");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(auxDir, { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    writeFileSync(join(capturesDir, "000-search.json"), JSON.stringify(flowCapture()));

    writeFileSync(join(auxDir, "locale-strings.json"), JSON.stringify({ hello: "hi" }));
    writeFileSync(join(auxDir, "feature-toggles.json"), JSON.stringify({ newSearch: true }));
    writeFileSync(
      join(auxDir, "aux-manifest.json"),
      JSON.stringify([
        {
          filename: "locale-strings.json",
          url: `https://${OWN_HOST}/aux/locale-strings.json`,
          hostname: OWN_HOST,
        },
        {
          filename: "feature-toggles.json",
          url: `https://${OWN_HOST}/aux/feature-toggles.json`,
          hostname: OWN_HOST,
        },
      ])
    );

    const siteId = `recon-aux-unrelated-omission-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        ownBackendHostnames: [OWN_HOST],
        steps: [{ step: "load the search results" }],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const fixturesDir = join(siteOutDir, "fixtures");
    expect(existsSync(fixturesDir)).toBe(false);

    const contractCode = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const uncommentedLines = contractCode
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"));
    const uncommentedCode = uncommentedLines.join("\n");
    expect(uncommentedCode).not.toContain("locale-strings.json");
    expect(uncommentedCode).not.toContain("feature-toggles.json");
  }, 30_000);
});
