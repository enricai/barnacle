import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withPersistedPersonaEnv } from "@/scripts/recon-generate";

describe("withPersistedPersonaEnv", () => {
  it("reads persisted values with empty env; env wins", () => {
    const d = mkdtempSync(join(tmpdir(), "persona-"));
    writeFileSync(join(d, "persona-env.json"), JSON.stringify({ RECON_EMAIL: "a@b.c", RECON_PHONE: "555" }));
    expect(withPersistedPersonaEnv(d, {}).RECON_EMAIL).toBe("a@b.c");
    const m = withPersistedPersonaEnv(d, { RECON_EMAIL: "x@y.z" });
    expect(m.RECON_EMAIL).toBe("x@y.z");
    expect(m.RECON_PHONE).toBe("555");
  });
  it("no file returns env", () => {
    const env = { A: "1" };
    expect(withPersistedPersonaEnv(mkdtempSync(join(tmpdir(), "p-")), env)).toBe(env);
  });
});
