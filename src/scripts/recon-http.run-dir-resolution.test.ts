import { mkdirSync, mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("recon run-dir resolution for reader scripts", () => {
  let base: string;
  beforeEach(() => {
    vi.resetModules();
    base = mkdtempSync(join(tmpdir(), "recon-rd-"));
    process.env.RECON_OUT_DIR = base;
    delete process.env.RECON_RUN_ID;
  });
  afterEach(() => {
    delete process.env.RECON_OUT_DIR;
  });

  it("adopts an existing run root without nesting a new run dir", async () => {
    const existing = join(base, "run-a");
    mkdirSync(join(existing, "graphql"), { recursive: true });
    const { adoptReconRunRoot } = await import("@/scripts/recon-shared");
    const dir = adoptReconRunRoot(existing);
    expect(dir.root).toBe(existing);
    expect(dir.graphqlDir).toBe(join(existing, "graphql"));
    expect(readdirSync(base)).toEqual(["run-a"]);
  });

  it("picks the newest run when RECON_RUN_ID is unset", async () => {
    for (const [name, t] of [["old", 1000], ["new", 2000]] as const) {
      mkdirSync(join(base, name));
      utimesSync(join(base, name), t, t);
    }
    const { resolveLatestReconRunRoot } = await import("@/scripts/recon-shared");
    expect(resolveLatestReconRunRoot()).toBe(join(base, "new"));
  });

  it("an explicit run dir wins over the newest run", async () => {
    const { resolveLatestReconRunRoot } = await import("@/scripts/recon-shared");
    expect(resolveLatestReconRunRoot("/x/y")).toBe("/x/y");
  });
});
