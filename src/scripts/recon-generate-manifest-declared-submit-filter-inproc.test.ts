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

const GENERATE_SCRIPT = join(__dirname, "recon-generate.ts");

let workDir: string | null = null;
let siteOutDir: string | null = null;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
});

describe("recon-generate (in-process): declared submit pattern filters a padded submit-manifest", () => {
  it("logs the manifest being filtered to the declared-pattern matches", async () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-manifest-filter-inproc-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
    const captures = buildWizardCheckoutCaptures();
    const manifest = captures.map((capture, index) => {
      const filename = `${String(index).padStart(3, "0")}-checkout-action.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
      return { index, filename, url: capture.url };
    });
    writeFileSync(join(runRoot, "submit-manifest.json"), JSON.stringify(manifest));
    const siteId = `recon-manifest-filter-inproc${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "fill out the sections" }, { step: "click place order", submitStep: true }],
        submitEndpointPattern: "place-order",
      })
    );
    const savedArgv = process.argv;
    const savedCwd = process.cwd();
    const sps = (["log", "info", "warn", "error"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {})
    );
    const writes = [process.stdout, process.stderr].map((st) =>
      vi.spyOn(st, "write").mockImplementation((() => true) as never)
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
      ];
      await main();
    } finally {
      process.argv = savedArgv;
      process.chdir(savedCwd);
      for (const sp of [...sps, ...writes]) sp.mockRestore();
    }
    expect(logged.join("\n")).toContain(
      `filtered submit-manifest.json from ${captures.length} to 1 capture(s) matching the declared submit pattern`
    );
  }, 60_000);
});
