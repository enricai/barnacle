/** Runs recon-http's real main() in a subprocess: --run-dir parsing and the empty-captures exit. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    process.argv = ["node", "/x/recon-http.ts", "--run-dir", join(dir, "run1")];
    vi.resetModules();
    try {
      await import("./recon-http.js");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    } finally {
      process.argv = origArgv;
      exit.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("recon-http main replay loop — shape verdict", () => {
  it("does not count a shape-diverging replay as passed and names the omitted header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-main-shape-"));
    const capDir = join(dir, "caps");
    mkdirSync(join(dir, "run1"), { recursive: true });
    mkdirSync(capDir, { recursive: true });
    writeFileSync(
      join(capDir, "c1.json"),
      JSON.stringify({
        method: "GET",
        url: "https://api.shape-test.example/v1/items",
        requestHeaders: { "x-key-inflection": "camel", accept: "application/json" },
        requestPostData: null,
        responseHeaders: { "content-type": "application/json" },
        responseBody: { itemId: 1, itemName: "a" },
        operationName: null,
        query: null,
      })
    );
    const lines: string[] = [];
    const rec = (m: unknown) => {
      const s = String(m);
      lines.push(s);
      if (s.startsWith("replay complete")) throw new Error("stop-after-replay");
    };
    const fakeLogger = {
      info: rec,
      warn: rec,
      error: rec,
      debug: () => undefined,
      child: () => fakeLogger,
    };
    vi.resetModules();
    vi.doMock("@/lib/logging", async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      getScriptLogger: () => fakeLogger,
    }));
    const origFetch = global.fetch;
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ item_id: 1, item_name: "a" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof fetch;
    const origArgv = process.argv;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    process.argv = [
      "node",
      "/x/recon-http.ts",
      "--run-dir",
      join(dir, "run1"),
      "--captures-dir",
      capDir,
    ];
    try {
      await import("./recon-http.js");
      await vi.waitFor(() => expect(lines.some((l) => l.startsWith("replay complete"))).toBe(true));
      expect(lines).toContain("replay complete: 0/1 passed");
      const warn = lines.find((l) => l.includes("response shape differs"));
      expect(warn).toBeDefined();
      expect(warn).toContain("x-key-inflection");
    } finally {
      process.argv = origArgv;
      global.fetch = origFetch;
      exit.mockRestore();
      vi.doUnmock("@/lib/logging");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
