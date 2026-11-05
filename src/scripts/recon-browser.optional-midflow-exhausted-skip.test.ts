/**
 * Optional steps with an exhausted cascade are skipped at any index; a failed run
 * leaves the flow file byte-identical. (Harness mirrors frame-passthrough test.)
 * Original header: parseCli()
 * reads `frameSelector` off an object-shape flow file, and main() must
 * forward the resolved FrameTarget into executeStepWithHealing rather than
 * silently dropping it. Distinct from flow-runner.frame-threading.test.ts
 * (which covers runHealingFlow's own resolve-and-thread behavior) — this
 * file exercises only the CLI's parse->params->cascade-call assembly.
 */

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  StepVerificationError,
  type StepVerificationErrorKind,
} from "@/scraper/errors";
import type { FrameTarget } from "@/scraper/frame-target";

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
  const actual =
    await importOriginal<typeof import("@/lib/telemetry/call-capture")>();
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
  buildAnthropicClient: () => ({
    messages: { parse: anthropicMessagesParseStub },
  }),
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

import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

function makeFakePage(): Stagehand {
  const session = { on: (): void => {}, off: (): void => {} };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: (): string => "https://example.com/apply",
    title: vi.fn().mockResolvedValue("Apply"),
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      if (typeof expr === "string" && expr.includes("document.body"))
        return 10_000;
      return null;
    }),
    frames: vi.fn().mockReturnValue([]),
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ cookies: [] }),
  } as unknown as Page;
  return {
    context: { awaitActivePage: async (): Promise<Page> => page },
  } as unknown as Stagehand;
}

describe("recon-browser — optional step with exhausted cascade", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-optional-skip-"));
    process.env.RECON_RUN_ID = "20260725-000000-optskip001";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingStub.mockReset();
    anthropicMessagesParseStub.mockReset();
    vi.mocked(createBrowserSession).mockReset();
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand: makeFakePage(),
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
  });

  function argvFor(flowFilePath: string): string[] {
    return [
      "node",
      "recon-browser.ts",
      "--url",
      "https://careers.example.org/apply",
      "--flow-file",
      flowFilePath,
    ];
  }

  it("skips a mid-flow optional step and runs the later steps", async () => {
    const flowFilePath = join(runsRoot, "recon-flow.json");
    const original = `${JSON.stringify({ steps: ["Click A", { step: "Tick maybe box", optional: true }, "Click C", "Click D"] }, null, 2)}\n`;
    writeFileSync(flowFilePath, original);
    executeStepWithHealingStub.mockImplementation(
      async (a: { step: string }) => {
        if (a.step === "Tick maybe box") {
          throw new StepVerificationError(
            "cascade exhausted",
            "cascade-exhausted",
          );
        }
        return "completed";
      },
    );
    process.argv = argvFor(flowFilePath);

    await main();

    const ran = executeStepWithHealingStub.mock.calls.map(
      (c) => (c[0] as { step: string }).step,
    );
    expect(ran).toEqual(["Click A", "Tick maybe box", "Click C", "Click D"]);
    expect(anthropicMessagesParseStub).not.toHaveBeenCalled();
    expect(readFileSync(flowFilePath, "utf8")).toBe(original);
  });

  it("leaves the flow file byte-identical when the run fails after a replan", async () => {
    const flowFilePath = join(runsRoot, "recon-flow.json");
    const original = `${JSON.stringify({ steps: ["Click A"] }, null, 2)}\n`;
    writeFileSync(flowFilePath, original);
    executeStepWithHealingStub.mockRejectedValue(
      new StepVerificationError("cascade exhausted", "cascade-exhausted"),
    );
    anthropicMessagesParseStub.mockResolvedValue({
      parsed_output: { outcome: "replan", steps: ["Click A alt"] },
      content: [{ type: "text", text: "" }],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    process.argv = argvFor(flowFilePath);

    await expect(main()).rejects.toThrow();

    expect(anthropicMessagesParseStub).toHaveBeenCalled();
    expect(readFileSync(flowFilePath, "utf8")).toBe(original);
    expect(
      readdirSync(runsRoot).filter((f) => f.endsWith(".bak.json")),
    ).toEqual([]);
  });
});
