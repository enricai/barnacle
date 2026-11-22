import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});

describe("recon-generate main() reads persona-env.json from the run dir", () => {
  it("runs the CLI with no RECON_* env and completes using the persisted persona", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-persona-rundir-cli-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
    writeFileSync(
      join(runRoot, "persona-env.json"),
      JSON.stringify({ RECON_EMAIL: "persisted-persona@example.io" })
    );
    buildWizardCheckoutCaptures().forEach((c, i) => {
      writeFileSync(
        join(capturesDir, `${String(i).padStart(3, "0")}-checkout-action.json`),
        JSON.stringify(c)
      );
    });
    const siteId = `recon-persona-rundir-cli-test${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: `Fill in the Email field with '$${"{RECON_EMAIL}"}'` },
          { step: "submit the application", submitStep: true },
        ],
      })
    );
    const vocab = join(workDir, "vocabulary.mjs");
    writeFileSync(
      vocab,
      `export const vocabulary = { subject: /(?!)/, exclusions: [], table: [[/\\bemail\\b/i, "Email"]] };\n`
    );
    const { RECON_EMAIL: _omit, ...env } = process.env;
    const result = spawnSync(
      TSX_BIN,
      [
        GENERATE_SCRIPT,
        "--site-id",
        siteId,
        "--run-dir",
        runRoot,
        "--emit",
        "ts",
        "--force",
        "--vocabulary",
        vocab,
      ],
      { cwd: RECON_GENERATE_CWD, encoding: "utf8", env }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain("persisted-persona@example.io");
  });
});
