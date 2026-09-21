import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Regression test for the report's exact repro: own-backend-host auxiliary
 * captures that are structurally unrelated to the plugin's core flow (a
 * locale/i18n string dictionary, a feature-flag/config resolver) alongside
 * a genuine reference-data capture (a currency list), all recorded with
 * correct own-host provenance in aux-manifest.json. The fix (removal of
 * recon-generate's unconditional aux-copy loop) means NONE of these are
 * ever auto-copied into the generated plugin's fixtures/ directory,
 * regardless of whether the content is domain-relevant — so the
 * irrelevant captures can never become dead weight in a committed
 * fixtures/ dir, which is what the report flagged.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_HOST = "api.example.com";

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

describe("recon-generate aux-fixture domain-relevance CLI e2e", () => {
  it("never auto-copies own-host aux captures into fixtures/, whether domain-irrelevant or genuine reference data", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-aux-domain-relevance-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    const auxDir = join(runRoot, "aux");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(auxDir, { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    writeFileSync(join(capturesDir, "000-home.json"), JSON.stringify(capture()));

    // Own-host, locale/i18n string-dictionary-shaped capture — unrelated to
    // the plugin's core flow.
    writeFileSync(join(auxDir, "dictionary.json"), JSON.stringify({ hello: "hi" }));
    // Own-host, feature-flag/config-resolver-shaped capture — unrelated to
    // the plugin's core flow.
    writeFileSync(join(auxDir, "resolve.json"), JSON.stringify({ enabled: true }));
    // Own-host, genuine reference-data capture (a currency list) — the kind
    // of aux file the auxiliary probe exists to harvest.
    writeFileSync(join(auxDir, "currencies.json"), JSON.stringify({ list: ["USD", "EUR"] }));
    writeFileSync(
      join(auxDir, "aux-manifest.json"),
      JSON.stringify([
        {
          filename: "dictionary.json",
          url: `https://${OWN_HOST}/pulse/api/v1/locales/en/dictionary`,
          hostname: OWN_HOST,
        },
        {
          filename: "resolve.json",
          url: `https://${OWN_HOST}/bin/services/core/flags/resolve.json`,
          hostname: OWN_HOST,
        },
        {
          filename: "currencies.json",
          url: `https://${OWN_HOST}/api/v1/currencies.json`,
          hostname: OWN_HOST,
        },
      ])
    );

    const siteId = `recon-aux-domain-relevance-test-${process.pid}`;
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

    // Root-cause fix: recon-generate never auto-copies any aux capture into
    // fixtures/ — relevant or not — so a domain-irrelevant own-host capture
    // can never land there as dead weight.
    const fixturesDir = join(siteOutDir, "fixtures");
    expect(existsSync(fixturesDir)).toBe(false);

    // All three own-host entries still surface as commented-out loadFixture
    // suggestions — the maintainer decides relevance and pulls the file
    // from the archived run's aux/ directory themselves.
    const contractCode = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contractCode).toContain("dictionary.json");
    expect(contractCode).toContain("resolve.json");
    expect(contractCode).toContain("currencies.json");
    expect(contractCode).not.toMatch(/^\s*const dictionary = loadFixture/m);
    expect(contractCode).not.toMatch(/^\s*const resolve = loadFixture/m);
    expect(contractCode).not.toMatch(/^\s*const currencies = loadFixture/m);
  }, 30_000);
});
