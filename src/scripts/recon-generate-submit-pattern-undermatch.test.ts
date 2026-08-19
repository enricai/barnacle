import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildWizardCheckoutCaptures } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Reproduces the reported defect: a declared `submitEndpointPattern` in
 * recon-flow.json that only matches the final "place order" call, even though
 * the same run captured 9 other genuine same-host, non-GET, 2xx section-save
 * POSTs (recon-generate.ts's `extractActionSequence` would keep all of them
 * absent a submitPatterns filter). `compileSubmitMatcher` +
 * `extractActionSequence(..., submitPatterns)` (recon-generate.ts:742-831)
 * silently narrows the sequence down to that one call, `isSubmissionFlow`
 * collapses to false, and the generator falls back to the generic
 * single-call `{ query }` template as if the flow only ever had one action —
 * even though 10 real action captures were on hand. This under-match is a
 * detection failure (the pattern is too narrow), not evidence the flow is
 * read-only, and must fail loudly instead of degrading quietly.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

let workDir: string | null = null;
let siteOutDir: string | null = null;
let flowFile: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  if (flowFile) rmSync(flowFile, { force: true });
  workDir = null;
  siteOutDir = null;
  flowFile = null;
});

describe("recon-generate: submitEndpointPattern under-match vs. raw action captures", () => {
  it("fails loudly instead of emitting the generic {query} single-endpoint fallback", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-submit-pattern-undermatch-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    const replaysDir = join(runRoot, "replays");
    const auxDir = join(runRoot, "aux");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(replaysDir, { recursive: true });
    mkdirSync(auxDir, { recursive: true });
    writeFileSync(join(replaysDir, "rate-limit.json"), JSON.stringify([]));

    const captures = buildWizardCheckoutCaptures();
    captures.forEach((capture, index) => {
      const filename = `${String(index).padStart(3, "0")}-checkout-action.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
    });

    const siteId = `recon-submit-pattern-undermatch-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    flowFile = join(siteOutDir, "recon-flow.json");
    // Declared pattern only matches the final place-order POST — under-covering
    // the 9 other genuine section-save POSTs the same run actually captured.
    writeFileSync(
      flowFile,
      JSON.stringify({
        steps: [
          { step: "fill out the shipping, billing, payment, and review sections" },
          { step: "click place order", submitStep: true },
        ],
        submitEndpointPattern: "/place-order$",
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toMatch(/submitEndpointPattern/);
    expect(output).toMatch(/under-match/);
    expect(existsSync(join(siteOutDir, "contract.ts"))).toBe(false);
  }, 30_000);
});
