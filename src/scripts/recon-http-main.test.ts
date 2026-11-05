/** Runs recon-http's real main() in a subprocess: --run-dir parsing and the empty-captures exit. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("recon-http main", () => {
  it("exits 1 with a no-captures error for an existing empty --run-dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-main-"));
    try {
      mkdirSync(join(dir, "run1"), { recursive: true });
      const r = spawnSync(
        resolve("node_modules/.bin/tsx"),
        [resolve("src/scripts/recon-http.ts"), "--run-dir", join(dir, "run1")],
        { encoding: "utf8", env: { ...process.env, RECON_OUT_DIR: dir }, timeout: 60_000 }
      );
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).toContain("has no captures");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

describe("recon-http main (in-process)", () => {
  it("parses --run-dir and exits 1 on no captures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-main-ip-"));
    mkdirSync(join(dir, "run1"), { recursive: true });
    const origArgv = process.argv;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit-called");
    }) as never);
    process.argv = ["node", "/x/recon-http.ts", "--run-dir", join(dir, "run1")];
    vi.resetModules();
    try {
      await import("./recon-http");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    } finally {
      process.argv = origArgv;
      exit.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
