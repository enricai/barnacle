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

describe("recon-generate fail-closed warn via CLI", () => {
  it("warns and falls back to browser-only when the declared submit endpoint never fires", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-failclosed-cli-"));
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
      // Shipping (the declared submit endpoint) is a GET read, so no write matches it.
      if (String(c.url).endsWith("/shipping")) (c as { method: string }).method = "GET";
      writeFileSync(
        join(capturesDir, `${String(i).padStart(3, "0")}-checkout-action.json`),
        JSON.stringify(c)
      );
    });
    const siteId = `recon-failclosed-cli-test${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        submitEndpointPattern: "/checkout/order-42/shipping",
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
    expect(result.stderr + result.stdout).toContain("falling back to a browser-only plugin");
    expect(result.stderr + result.stdout).toContain("stops short of the flow's submit step");
  });
});
