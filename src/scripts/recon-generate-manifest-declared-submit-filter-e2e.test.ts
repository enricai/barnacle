import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildWizardCheckoutCaptures } from "@/scripts/recon-generate-multicall-fixture";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate: declared submit pattern filters a padded submit-manifest", () => {
  it("logs the manifest being filtered to the declared-pattern matches", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-manifest-filter-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    const captures = buildWizardCheckoutCaptures();
    const manifest = captures.map((capture, index) => {
      const filename = `${String(index).padStart(3, "0")}-checkout-action.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
      return { index, filename, url: capture.url };
    });
    // Manifest padded with every capture, not just the declared submit.
    writeFileSync(join(runRoot, "submit-manifest.json"), JSON.stringify(manifest));

    const siteId = `recon-manifest-filter-test-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "fill out the sections" }, { step: "click place order", submitStep: true }],
        submitEndpointPattern: "place-order",
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
    );
    const out = `${result.stdout}\n${result.stderr}`;
    expect(result.status, out).toBe(0);
    expect(out).toContain(
      `filtered submit-manifest.json from ${captures.length} to 1 capture(s) matching the declared submit pattern`
    );
  }, 60_000);
});
