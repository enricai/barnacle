/** Runs recon-http's real main() in a subprocess: --run-dir parsing and the empty-captures exit. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
