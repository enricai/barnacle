/**
 * Regression test for the persisted --flow-file load path: a step already
 * on disk (e.g. written by a previous session's self-heal, origin:
 * "replan", no submitStep key) with submit-shaped instruction text must
 * get submitStep: true from parseCli() itself, before any execution loop
 * ever sees the step.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
      maxCascadeReplans: 5,
      maxProbeReplans: 5,
      maxTransportRetries: 1,
    },
    telemetry: {
      callsNdjsonPath: ".barnacle/calls.ndjson",
    },
  },
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));
vi.mock("@/scraper/session", () => ({ createBrowserSession: vi.fn() }));

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({
  getLogger: () => loggerStub,
  getScriptLogger: () => loggerStub,
}));

describe("recon-browser/parseCli — flow-file submitStep seeded at load", () => {
  const ORIGINAL_ARGV = process.argv;
  let tmpDir: string;

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("seeds submitStep: true for a persisted, unflagged replan step with submit-shaped instruction text", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-flow-file-submit-seed-"));
    const flowFilePath = join(tmpDir, "flow.json");
    writeFileSync(
      flowFilePath,
      JSON.stringify([
        {
          step: "Click the submit button to finalize the form",
          optional: true,
          origin: "replan",
        },
      ])
    );

    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://example.com",
      "--flow-file",
      flowFilePath,
    ];

    const parsed = parseCli();

    expect(parsed.flow[0]?.submitStep).toBe(true);
  });
});
