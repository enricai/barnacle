/**
 * Regression guard for the load-time `seedSubmitStepFromOwnInstructionText`
 * wiring in `parseCli()`'s `--flow-file` path: proves seeding does NOT touch
 * steps outside its documented contract, as a counterpart to the seeding-DOES-
 * happen coverage in `recon-browser.test.ts`'s `seedSubmitStepFromOwnInstructionText`
 * describe block, but exercised through the full CLI load path rather than the
 * pure function directly, so it also catches a regression in the wiring itself.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseCli } from "@/scripts/recon-browser";

vi.mock("@/config", () => ({
  config: {
    scraper: {
      useBedrock: false,
      anthropicApiKey: "test-key",
      model: "anthropic/claude-sonnet-4-6",
      proxyType: "residential",
      steelSessionTimeoutMs: 30000,
      frameReadyTimeoutMs: 20_000,
      frameDocumentReadyTimeoutMs: 5_000,
      frameEvaluateTimeoutMs: 30_000,
    },
    telemetry: {
      callsNdjsonPath: ".barnacle/calls.ndjson",
    },
  },
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));
vi.mock("@/scraper/session", () => ({ createBrowserSession: vi.fn() }));

describe("recon-browser/parseCli --flow-file — submitStep seeding scope regression", () => {
  const ORIGINAL_ARGV = process.argv;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-flow-file-seeding-scope-"));
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("leaves an already-flagged non-submit-shaped step untouched, does not flag a non-submit-shaped step, and leaves an already-flagged submit-shaped step untouched", () => {
    const flowPath = join(tmpDir, "flow.json");
    writeFileSync(
      flowPath,
      JSON.stringify([
        { step: "Fill in the first name field", submitStep: true },
        "Select the state dropdown option",
        { step: "Click Submit", submitStep: true },
      ])
    );

    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://example.com",
      "--flow-file",
      flowPath,
    ];

    const parsed = parseCli();

    expect(parsed.flow[0]!.instruction).toBe("Fill in the first name field");
    expect(parsed.flow[0]!.submitStep).toBe(true);

    expect(parsed.flow[1]!.instruction).toBe("Select the state dropdown option");
    expect(parsed.flow[1]!.submitStep).toBeFalsy();

    expect(parsed.flow[2]!.instruction).toBe("Click Submit");
    expect(parsed.flow[2]!.submitStep).toBe(true);
  });
});
