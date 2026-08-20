import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Regression test for the report's exact ask: a flow declaring
 * `ownBackendHostnames` must yield zero fixtures from hosts outside that
 * list, even when the run's `aux/` directory holds stale/unfiltered
 * entries — files with no `aux-manifest.json` entry at all, which is what
 * a pre-fix run dir looks like. Exercises the real `recon:generate` CLI
 * against a temp run dir rather than re-deriving the filtering logic
 * inline.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_HOST = "api.example.com";
const OTHER_HOST = "config.other-vendor.example";

function capture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "home",
    method: "GET",
    url: `https://${OWN_HOST}/apply`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "text/html" },
    responseBody: null,
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

describe("recon-generate aux-fixture host allowlist CLI e2e", () => {
  it("copies zero fixtures from hosts outside ownBackendHostnames, including stale unmanifested entries", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-aux-host-allowlist-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    const auxDir = join(runRoot, "aux");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(auxDir, { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    writeFileSync(join(capturesDir, "000-home.json"), JSON.stringify(capture()));

    // Own-backend fixture with correct provenance recorded in aux-manifest.json.
    writeFileSync(join(auxDir, "own-backend.json"), JSON.stringify({ ok: true }));
    // Third-party fixture WITH a manifest entry declaring a disallowed host.
    writeFileSync(join(auxDir, "other-vendor-manifested.json"), JSON.stringify({ vendor: true }));
    // Third-party fixture with NO manifest entry at all — simulates a stale,
    // pre-fix aux/ dir where nothing recorded provenance.
    writeFileSync(join(auxDir, "other-vendor-stale.json"), JSON.stringify({ stale: true }));
    writeFileSync(
      join(auxDir, "aux-manifest.json"),
      JSON.stringify([
        {
          filename: "own-backend.json",
          url: `https://${OWN_HOST}/aux/own-backend.json`,
          hostname: OWN_HOST,
        },
        {
          filename: "other-vendor-manifested.json",
          url: `https://${OTHER_HOST}/aux/other-vendor-manifested.json`,
          hostname: OTHER_HOST,
        },
      ])
    );

    const siteId = `recon-aux-host-allowlist-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        ownBackendHostnames: [OWN_HOST],
        steps: [{ step: "load the application form" }],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const fixturesDir = join(siteOutDir, "fixtures");
    const fixtureFiles = existsSync(fixturesDir) ? readdirSync(fixturesDir) : [];

    expect(fixtureFiles).toContain("own-backend.json");
    expect(fixtureFiles).not.toContain("other-vendor-manifested.json");
    expect(fixtureFiles).not.toContain("other-vendor-stale.json");
    expect(fixtureFiles.length).toBe(1);
  }, 30_000);
});
