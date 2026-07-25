/**
 * Regression tests for the recon CLI's frameSelector hand-off: parseCli()
 * reads `frameSelector` off an object-shape flow file, and main() must
 * forward the resolved FrameTarget into executeStepWithHealing rather than
 * silently dropping it. Distinct from flow-runner.frame-threading.test.ts
 * (which covers runHealingFlow's own resolve-and-thread behavior) — this
 * file exercises only the CLI's parse->params->cascade-call assembly.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StepVerificationErrorKind } from "@/scraper/errors";
import type { FrameTarget } from "@/scraper/frame-target";

vi.mock("@/config", () => ({
  config: {
    scraper: {
      useBedrock: false,
      anthropicApiKey: "test-key",
      model: "anthropic/claude-sonnet-4-6",
      proxyType: "residential",
      steelSessionTimeoutMs: 30000,
    },
    telemetry: {
      callsNdjsonPath: ".barnacle/calls.ndjson",
    },
  },
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));
vi.mock("@/scraper/session", () => ({ createBrowserSession: vi.fn() }));
vi.mock("@/scraper/errors", () => ({
  StepVerificationError: class StepVerificationError extends Error {
    readonly kind: StepVerificationErrorKind;
    constructor(message = "step failed", kind: StepVerificationErrorKind = "cascade-exhausted") {
      super(message);
      this.kind = kind;
    }
  },
}));

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

import { createBrowserSession } from "@/scraper/session";
import { main, parseCli } from "@/scripts/recon-browser";

describe("recon-browser CLI/parseCli — frameSelector parsing", () => {
  const ORIGINAL_ARGV = process.argv;

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
  });

  it("parses frameSelector from an object-shape flow file", () => {
    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://example.com",
      "--flow",
      JSON.stringify({
        steps: ["Click Manual Application"],
        frameSelector: "#talemetry_apply_iframe",
      }),
    ];

    expect(parseCli().frameSelector).toBe("#talemetry_apply_iframe");
  });

  it("resolves frameSelector to null for a legacy array-shape flow file", () => {
    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://example.com",
      "--flow",
      JSON.stringify(["Click Apply", "Fill First Name"]),
    ];

    expect(parseCli().frameSelector).toBeNull();
  });

  it("resolves frameSelector to null when the object-shape flow omits it", () => {
    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://example.com",
      "--flow",
      JSON.stringify({ steps: ["Click Apply"] }),
    ];

    expect(parseCli().frameSelector).toBeNull();
  });
});

describe("recon-browser CLI/main — frameSelector reaches executeStepWithHealing", () => {
  /**
   * Minimal Page/Stagehand double: enough surface for main()'s pre-loop
   * navigation/SPA-readiness gate, wireSignalCapture's CDP wiring, cookie-jar
   * snapshots, and (when `iframeSrc` is set) resolveFrameTarget's iframe-src
   * lookup + page.frames() scan.
   */
  function makeFakePage(opts: { iframeSrc?: string; frameUrl?: string } = {}): {
    page: Page;
    stagehand: Stagehand;
  } {
    const session = {
      on: (): void => {},
      off: (): void => {},
    };
    const childFrame = {
      evaluate: vi.fn().mockResolvedValue(opts.frameUrl ?? ""),
    };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: (): string => "https://example.com/apply",
      title: vi.fn().mockResolvedValue("Apply"),
      evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
        if (typeof expr === "string" && expr.includes("document.body")) {
          return 10_000;
        }
        if (typeof expr === "string" && expr.includes("querySelector")) {
          return opts.iframeSrc ?? null;
        }
        return null;
      }),
      frames: vi.fn().mockReturnValue(opts.frameUrl ? [childFrame] : []),
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP: vi.fn().mockResolvedValue({ cookies: [] }),
    } as unknown as Page;
    const stagehand = {
      context: { awaitActivePage: async (): Promise<Page> => page },
    } as unknown as Stagehand;
    return { page, stagehand };
  }

  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-frame-passthrough-"));
    process.env.RECON_RUN_ID = "20260725-000000-passthrough1";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingStub.mockReset();
    executeStepWithHealingStub.mockResolvedValue("ok");
    vi.mocked(createBrowserSession).mockReset();
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
    executeStepWithHealingStub.mockReset();
  });

  it("forwards an object-shape flow's frameSelector as the exact resolved FrameTarget", async () => {
    const { stagehand } = makeFakePage({
      iframeSrc: "https://apply.talemetry.com/application/abc-123",
      frameUrl: "https://apply.talemetry.com/application/abc-123",
    });
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
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
        steps: ["Click Manual Application"],
        frameSelector: "#talemetry_apply_iframe",
      }),
    ];

    await main();

    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(1);
    const callArgs = executeStepWithHealingStub.mock.calls[0]?.[0] as { frameTarget?: FrameTarget };
    expect(callArgs.frameTarget?.frameSelector).toBe("#talemetry_apply_iframe");
    expect(callArgs.frameTarget?.frame).not.toBeNull();
  });

  it("forwards frameSelector: undefined (main-frame FrameTarget) for a legacy array-shape flow", async () => {
    const { stagehand } = makeFakePage();
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://example.com/apply",
      "--flow",
      JSON.stringify(["Click Apply"]),
    ];

    await main();

    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(1);
    const callArgs = executeStepWithHealingStub.mock.calls[0]?.[0] as { frameTarget?: FrameTarget };
    expect(callArgs.frameTarget?.frame).toBeNull();
    expect(callArgs.frameTarget?.frameSelector).toBeNull();
  });

  it("forwards frameSelector: undefined (not an empty string) when an object-shape flow omits it", async () => {
    const { stagehand } = makeFakePage();
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://example.com/apply",
      "--flow",
      JSON.stringify({ steps: ["Click Apply"] }),
    ];

    await main();

    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(1);
    const callArgs = executeStepWithHealingStub.mock.calls[0]?.[0] as { frameTarget?: FrameTarget };
    expect(callArgs.frameTarget?.frame).toBeNull();
    expect(callArgs.frameTarget?.frameSelector).toBeNull();
    expect(callArgs.frameTarget?.frameSelector).not.toBe("");
  });
});
