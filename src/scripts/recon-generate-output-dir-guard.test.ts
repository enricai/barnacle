import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findExistingGeneratedPaths } from "./recon-generate";

const has =
  (...present: string[]) =>
  (p: string) =>
    present.includes(p);

describe("findExistingGeneratedPaths", () => {
  it("allows a dir holding only recon-flow.json and telemetry/", () => {
    expect(
      findExistingGeneratedPaths(
        "src/sites/x",
        has("src/sites/x", "src/sites/x/recon-flow.json", "src/sites/x/telemetry")
      )
    ).toEqual([]);
  });
  it.each(["contract.ts", "index.ts", "flows"])("reports %s", (n) => {
    expect(findExistingGeneratedPaths("src/sites/x", has(`src/sites/x/${n}`))).toEqual([
      `src/sites/x/${n}`,
    ]);
  });
});

describe("recon-generate main() guard (end to end)", () => {
  it("exits 1 and names the existing file when contract.ts exists without --force", () => {
    const root = join(__dirname, "..", "..");
    const siteId = `zz-guard-${process.pid}`;
    const siteDir = join(root, "src", "sites", siteId);
    try {
      mkdirSync(siteDir, { recursive: true });
      writeFileSync(join(siteDir, "contract.ts"), "");
      const r = spawnSync(
        join(root, "node_modules", ".bin", "tsx"),
        [join(root, "src/scripts/recon-generate.ts"), "--site-id", siteId],
        { cwd: root, encoding: "utf8", env: { ...process.env, TMPDIR: "/tmp" } }
      );
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
      expect(`${r.stdout}${r.stderr}`).toContain(`src/sites/${siteId}/contract.ts already exists`);
    } finally {
      rmSync(siteDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe("recon-generate main() guard (in-process)", () => {
  it("calls process.exit(1) naming the existing file when contract.ts exists without --force", async () => {
    const root = join(__dirname, "..", "..");
    const siteId = `zz-guard-ip-${process.pid}`;
    const siteDir = join(root, "src", "sites", siteId);
    const origArgv = process.argv;
    let exited = false;
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      if (exited) return undefined; // the .catch handler's own exit(1) after our throw
      exited = true;
      throw new Error(`exit:${code}`);
    }) as never);
    const out: string[] = [];
    const capture = ((s: string) => {
      out.push(String(s));
      return true;
    }) as never;
    const w = vi.spyOn(process.stderr, "write").mockImplementation(capture);
    const w2 = vi.spyOn(process.stdout, "write").mockImplementation(capture);
    try {
      mkdirSync(siteDir, { recursive: true });
      writeFileSync(join(siteDir, "contract.ts"), "");
      process.argv = ["node", "/x/recon-generate.ts", "--site-id", siteId];
      vi.resetModules();
      await import("./recon-generate.js");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(out.join("")).toContain(`src/sites/${siteId}/contract.ts already exists`);
    } finally {
      process.argv = origArgv;
      exit.mockRestore();
      w.mockRestore();
      w2.mockRestore();
      rmSync(siteDir, { recursive: true, force: true });
    }
  }, 60000);
});
