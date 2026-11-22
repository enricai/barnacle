/**
 * Per-step frameSelector: normalize/denormalize round trip keeps it (forcing
 * object form), and the step loop resolves step.frameSelector ?? flow one.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/telemetry/call-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telemetry/call-capture")>();
  return {
    ...actual,
    captureLlmCall: vi.fn().mockResolvedValue(undefined),
  };
});

// buildAnthropicClient stub for the replan-driven write-back test — main()
// bails out of the replan dispatcher when the client is null, so a non-null
// stub is required to reach persistReplannedFlow at all. messages.parse is
// exposed as a hoisted spy so individual tests can shape its response.
const { anthropicMessagesParseStub } = vi.hoisted(() => ({
  anthropicMessagesParseStub: vi.fn(),
}));
vi.mock("@/lib/llm/anthropic-client", () => ({
  buildAnthropicClient: () => ({ messages: { parse: anthropicMessagesParseStub } }),
  buildRephraseModel: () => null,
}));

// executeStepWithHealing spy so we can assert exactly what main() forwards
// into the cascade call — every other flow-runner export stays real.
const { executeStepWithHealingStub } = vi.hoisted(() => ({
  executeStepWithHealingStub: vi.fn(),
}));
vi.mock("@/scraper/flow-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/flow-runner")>();
  return {
    ...actual,
    executeStepWithHealing: executeStepWithHealingStub,
  };
});

const { resolveFrameTargetSpy } = vi.hoisted(() => ({ resolveFrameTargetSpy: vi.fn() }));
vi.mock("@/scraper/frame-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/frame-target")>();
  return { ...actual, resolveFrameTarget: resolveFrameTargetSpy };
});

import { createBrowserSession } from "@/scraper/session";
import { denormalizeStep, main, normalizeFlow } from "@/scripts/recon-browser";

describe("normalizeFlow/denormalizeStep — per-step frameSelector", () => {
  it("round-trips a step frameSelector in object form", () => {
    const [n] = normalizeFlow([{ step: "Click Next", frameSelector: "#f2" } as never]);
    expect(n!.frameSelector).toBe("#f2");
    expect(denormalizeStep(n!)).toEqual({ step: "Click Next", frameSelector: "#f2" });
  });

  it("keeps a plain step as a bare string", () => {
    const [n] = normalizeFlow(["Click Next"]);
    expect(denormalizeStep(n!)).toBe("Click Next");
  });
});

describe("recon-browser step loop — per-step frameSelector", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-step-frame-"));
    process.env.RECON_RUN_ID = "20260725-000000-stepframe1";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingStub.mockReset();
    executeStepWithHealingStub.mockResolvedValue("ok");
    resolveFrameTargetSpy.mockReset();
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
  });

  it("resolves the step's selector, else the flow one", async () => {
    const session = { on: (): void => {}, off: (): void => {} };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: (): string => "https://example.com/apply",
      title: vi.fn().mockResolvedValue("Apply"),
      evaluate: vi
        .fn()
        .mockImplementation(async (expr: unknown) =>
          typeof expr === "string" && expr.includes("document.body") ? 10_000 : null
        ),
      frames: vi.fn().mockReturnValue([]),
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP: vi.fn().mockResolvedValue({ cookies: [] }),
    } as unknown as Page;
    const stagehand = {
      context: { awaitActivePage: async (): Promise<Page> => page },
    } as unknown as Stagehand;
    resolveFrameTargetSpy.mockResolvedValue({ frameSelector: null, url: async () => page.url() });
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "s",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://example.com/apply",
      "--flow",
      JSON.stringify({
        steps: ["Click A", { step: "Click B", frameSelector: "#step_frame" }],
        frameSelector: "#flow_frame",
      }),
    ];
    await main();

    const selectors = resolveFrameTargetSpy.mock.calls.map((c) => c[1]);
    expect(selectors).toContain("#flow_frame");
    expect(selectors).toContain("#step_frame");
    expect(selectors.indexOf("#flow_frame")).toBeLessThan(selectors.indexOf("#step_frame"));
  });
});
