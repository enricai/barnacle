import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildWizardCheckoutCaptures } from "@/scripts/recon-generate-multicall-fixture";

const logged = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/logging", async (orig) => {
  const real = await orig<typeof import("@/lib/logging")>();
  const rec = (m: unknown) => {
    logged.push(String(m));
  };
  return {
    ...real,
    getScriptLogger: () => ({
      info: rec,
      warn: rec,
      error: rec,
      debug: rec,
      trace: rec,
      fatal: rec,
      child: () => ({ info: rec, warn: rec, error: rec, debug: rec }),
    }),
  };
});

const REPO_ROOT = join(__dirname, "..", "..");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

let workDir: string | null = null;
let siteOutDir: string | null = null;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
});

describe("recon-generate fail-closed warn via CLI", () => {
  it("warns in-process and falls back to browser-only when the declared submit endpoint never fires", async () => {
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
    const savedArgv = process.argv;
    const savedEmail = process.env.RECON_EMAIL;
    delete process.env.RECON_EMAIL;
    const savedCwd = process.cwd();
    const out: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
        out.push(a.join(" "));
      })
    );
    const writes = [process.stdout, process.stderr].map((st) =>
      vi.spyOn(st, "write").mockImplementation(((c: unknown) => {
        out.push(String(c));
        return true;
      }) as never)
    );
    try {
      process.chdir(RECON_GENERATE_CWD);
      process.argv = [
        "node",
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
      ];
      await main();
    } finally {
      process.argv = savedArgv;
      process.chdir(savedCwd);
      if (savedEmail !== undefined) process.env.RECON_EMAIL = savedEmail;
      for (const sp of [...spies, ...writes]) sp.mockRestore();
    }
    const text = [...out, ...logged].join("\n");
    expect(text).toContain("falling back to a browser-only plugin");
    expect(text).toContain("stops short of the flow's submit step");
  });
});
