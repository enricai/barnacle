import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOCATED_PHONE_PATTERN,
  allocateFictionalPhone,
  parseCli,
} from "@/scripts/recon-browser";

const ORIGINAL_ARGV = process.argv;
const base = ["node", "recon-browser.ts", "--url", "https://example.com", "--flow", '["Click Apply"]'];

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
  vi.restoreAllMocks();
});

describe("recon-browser --allocate-phone", () => {
  it("accepts an UPPERCASE_SNAKE_CASE name", () => {
    process.argv = [...base, "--allocate-phone", "APPLICANT_PHONE"];
    const parsed = parseCli();
    expect(parsed.allocatePhoneEnvVar).toBe("APPLICANT_PHONE");
    expect(parsed.allocateEmailEnvVar).toBeNull();
  });

  it("leaves allocate-email unchanged", () => {
    process.argv = [...base, "--allocate-email", "APPLICANT_EMAIL"];
    const parsed = parseCli();
    expect(parsed.allocateEmailEnvVar).toBe("APPLICANT_EMAIL");
    expect(parsed.allocatePhoneEnvVar).toBeNull();
  });

  it("rejects a lowercase name", () => {
    process.argv = [...base, "--allocate-phone", "applicant_phone"];
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    expect(() => parseCli()).toThrow("exit 1");
  });

  it("allocates distinct numbers in the reserved fictional range", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const p = allocateFictionalPhone();
      expect(p).toMatch(ALLOCATED_PHONE_PATTERN);
      seen.add(p);
    }
    expect(allocateFictionalPhone()).not.toBe(allocateFictionalPhone());
    expect(seen.size).toBeGreaterThan(1);
  });
});
