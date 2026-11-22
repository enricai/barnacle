import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectAllocatedPersonaEnv, persistPersonaEnv } from "@/scripts/recon-browser";
import { harvestRunPersonaBindings } from "@/scripts/recon-generate";

const vocab = {
  subject: /\b(the\s+)?(test\s+)?(candidate|applicant)'?s\b/i,
  exclusions: [],
  table: [
    [/\bemail\b/i, "Email"],
    [/\bphone\b/i, "Phone"],
    [/\bpassword\b/i, "Password"],
  ],
} as never;
const steps = [
  "Fill in the Email field with '${RECON_EMAIL}'",
  "Fill in the Phone field with '${RECON_PHONE}'",
  "Fill in the Password field with '${RECON_PASSWORD}'",
] as never;

describe("persona run-dir handoff", () => {
  it("binds Email/Phone/Password from the run dir with empty env", () => {
    const root = mkdtempSync(join(tmpdir(), "prd-"));
    persistPersonaEnv(
      root,
      collectAllocatedPersonaEnv({
        emailEnvVar: "RECON_EMAIL",
        email: "a@b.io",
        phoneEnvVar: "RECON_PHONE",
        password: "pw-9",
        allocatePhone: () => "5551230000",
      })
    );
    expect(JSON.parse(readFileSync(join(root, "persona-env.json"), "utf8"))).toMatchObject({
      RECON_EMAIL: "a@b.io",
      RECON_PHONE: "5551230000",
      RECON_PASSWORD: "pw-9",
    });
    const got = harvestRunPersonaBindings(steps, vocab, root, {});
    expect(got.get("a@b.io")).toBe("payload.Email");
    expect(got.get("5551230000")).toBe("payload.Phone");
    expect(got.get("pw-9")).toBe("payload.Password");
  });

  it("env-only still works without a persona file", () => {
    const root = mkdtempSync(join(tmpdir(), "prd-"));
    const got = harvestRunPersonaBindings(steps, vocab, root, { RECON_EMAIL: "e@x.io" });
    expect(got.get("e@x.io")).toBe("payload.Email");
  });

  it("real env wins over persisted", () => {
    const root = mkdtempSync(join(tmpdir(), "prd-"));
    writeFileSync(join(root, "persona-env.json"), JSON.stringify({ RECON_EMAIL: "old@x.io" }));
    const got = harvestRunPersonaBindings(steps, vocab, root, { RECON_EMAIL: "new@x.io" });
    expect(got.get("new@x.io")).toBe("payload.Email");
    expect(got.has("old@x.io")).toBe(false);
  });
});
