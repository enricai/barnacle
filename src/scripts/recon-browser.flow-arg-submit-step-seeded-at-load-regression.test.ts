import { afterEach, describe, expect, it } from "vitest";
import { parseCli } from "@/scripts/recon-browser";

describe("recon-browser/parseCli — --flow submitStep seeded at load", () => {
  const ORIGINAL_ARGV = process.argv;

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
  });

  it("seeds submitStep from instruction text for an object-shape --flow arg", () => {
    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://example.com",
      "--flow",
      JSON.stringify({
        steps: [{ step: "Submit the completed form to finish", optional: false }],
      }),
    ];

    const parsed = parseCli();
    expect(parsed.flow[0]?.submitStep).toBe(true);
  });

  it("seeds submitStep from instruction text for a legacy bare-array --flow arg", () => {
    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://example.com",
      "--flow",
      JSON.stringify(["Submit the completed form to finish"]),
    ];

    const parsed = parseCli();
    expect(parsed.flow[0]?.submitStep).toBe(true);
  });
});
