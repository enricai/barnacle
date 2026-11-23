import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

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
    telemetry: { callsNdjsonPath: ".barnacle/calls.ndjson" },
  },
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));
vi.mock("@/scraper/session", () => ({ createBrowserSession: vi.fn() }));

import {
  denormalizeStep,
  normalizeFlow,
  persistReplannedFlow,
  RECON_FLOW_FILE_SCHEMA,
} from "./recon-browser.js";

const FLOW = {
  steps: [
    "Click Next",
    { step: "Click the final Submit button", submitStep: true, declareOnly: true },
  ],
};

describe("recon-browser declareOnly step", () => {
  it("parses with declareOnly and defaults it to false", () => {
    const r = RECON_FLOW_FILE_SCHEMA.parse({
      steps: [{ step: "Click Go" }, FLOW.steps[1]],
    }) as { steps: Array<{ declareOnly: boolean }> };
    expect(r.steps[0]!.declareOnly).toBe(false);
    expect(r.steps[1]!.declareOnly).toBe(true);
  });

  it("round-trips through normalizeFlow/denormalizeStep", () => {
    const parsed = RECON_FLOW_FILE_SCHEMA.parse(FLOW) as { steps: never[] };
    const norm = normalizeFlow(parsed.steps);
    expect(norm[1]!.declareOnly).toBe(true);
    expect(norm[1]!.submitStep).toBe(true);
    expect(denormalizeStep(norm[1]!)).toEqual({
      step: "Click the final Submit button",
      submitStep: true,
      declareOnly: true,
    });
    expect(denormalizeStep(norm[0]!)).toBe("Click Next");
  });

  it("persists the declareOnly flag in the written flow", () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-declare-only-"));
    try {
      const parsed = RECON_FLOW_FILE_SCHEMA.parse(FLOW) as { steps: never[] };
      const finalPlan = normalizeFlow(parsed.steps);
      const runDir = join(dir, "run");
      const flowFile = join(dir, "flow.json");
      writeFileSync(flowFile, JSON.stringify(FLOW));
      persistReplannedFlow({
        flowFile,
        runDir,
        finalPlan,
        replanEvents: [],
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
        originalShape: "object",
      });
      const out = JSON.parse(readFileSync(join(runDir, "recon-flow.json"), "utf8"));
      expect(out.steps[1].declareOnly).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
