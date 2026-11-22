import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectAllocatedPersonaEnv, persistPersonaEnv } from "@/scripts/recon-browser";
import { harvestPersonaBindings, harvestRunPersonaBindings } from "@/scripts/recon-generate";

describe("collectAllocatedPersonaEnv / persistPersonaEnv", () => {
  it("collects email, password and phone and persists them", () => {
    const env = collectAllocatedPersonaEnv({
      emailEnvVar: "E",
      email: "a@b.c",
      phoneEnvVar: "P",
      password: "pw",
      allocatePhone: () => "+12025550123",
    });
    expect(env).toEqual({ E: "a@b.c", RECON_PASSWORD: "pw", P: "+12025550123" });
    const root = join(mkdtempSync(join(tmpdir(), "pe-")), "nested");
    persistPersonaEnv(root, env);
    expect(JSON.parse(readFileSync(join(root, "persona-env.json"), "utf8"))).toEqual(env);
  });
  it("empty collects nothing and writes no file", () => {
    const env = collectAllocatedPersonaEnv({
      emailEnvVar: null,
      email: null,
      phoneEnvVar: null,
      password: undefined,
      allocatePhone: () => {
        throw new Error("unused");
      },
    });
    expect(env).toEqual({});
    const root = mkdtempSync(join(tmpdir(), "pe-"));
    persistPersonaEnv(root, env);
    expect(existsSync(join(root, "persona-env.json"))).toBe(false);
  });
});

describe("harvestRunPersonaBindings", () => {
  it("uses persisted env when process env is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "pe-"));
    writeFileSync(join(root, "persona-env.json"), JSON.stringify({ RECON_EMAIL: "z@q.io" }));
    const steps = ["Fill in the Email field with '${RECON_EMAIL}'"];
    const vocab = { exclusions: [] } as never;
    const got = harvestRunPersonaBindings(steps as never, vocab, root, {});
    const want = harvestPersonaBindings(steps as never, vocab, { RECON_EMAIL: "z@q.io" });
    expect([...got]).toEqual([...want]);
  });
});
