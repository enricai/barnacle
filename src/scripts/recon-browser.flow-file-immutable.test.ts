import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

import { type NormalizedStep, persistReplannedFlow, type ReplanEvent } from "./recon-browser.js";

describe("recon-browser flow-file immutability", () => {
  it("leaves the input flow file byte-identical and writes the replanned flow to the run dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "recon-immutable-"));
    try {
      const flowFile = join(dir, "flow.json");
      const original = '{\n    "steps": ["A"],  "secret": "x"\n}\n';
      writeFileSync(flowFile, original);
      const runDir = join(dir, "run");
      const finalPlan: NormalizedStep[] = [
        { instruction: "A", optional: false, upload: false, origin: "original" },
        { instruction: "Bridge", optional: false, upload: false, origin: "replan" },
      ];
      const replanEvents: ReplanEvent[] = [
        {
          replanIndex: 1,
          cause: "cascade-exhausted",
          indexAtFailure: 0,
          failedInstruction: "A",
          replanSteps: finalPlan,
          timestamp: "2026-06-03T20:00:00.000Z",
          pageState: { url: "https://example.com", htmlLength: 1 },
        },
      ];
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
      persistReplannedFlow({
        flowFile,
        runDir,
        finalPlan,
        replanEvents,
        logger,
        originalShape: "object",
      });

      expect(readFileSync(flowFile, "utf8")).toBe(original);
      expect(readdirSync(dir).sort()).toEqual(["flow.json", "run"]);
      const out = JSON.parse(readFileSync(join(runDir, "recon-flow.json"), "utf8"));
      expect(out.steps).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
