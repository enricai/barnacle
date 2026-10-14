/**
 * Caller-side wiring for a step that opens a new tab: main()'s step loop must
 * hand later steps (frame target, executeStepWithHealing) the adopted page and
 * move network capture onto it so captures from the new page are recorded.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@browserbasehq/stagehand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StepVerificationErrorKind } from "@/scraper/errors";

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

vi.mock("@/lib/llm/anthropic-client", () => ({
  buildAnthropicClient: () => null,
  buildRephraseModel: () => null,
}));

// executeStepWithHealing and executeNavigateStep are both spied so tests can
// assert exactly which one main()'s step loop dispatches to; every other
// flow-runner export stays real.
const { executeStepWithHealingStub, executeNavigateStepStub } = vi.hoisted(() => ({
  executeStepWithHealingStub: vi.fn(),
  executeNavigateStepStub: vi.fn(),
}));
vi.mock("@/scraper/flow-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/flow-runner")>();
  return {
    ...actual,
    executeStepWithHealing: executeStepWithHealingStub,
    executeNavigateStep: executeNavigateStepStub,
  };
});

import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

type Handler = (params: Record<string, unknown>) => void;

function makeFakePage(url: string): {
  page: Page;
  emitCapture: (requestId: string) => Promise<void>;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, Set<Handler>>();
  const session = {
    on: (event: string, h: Handler): void => {
      handlers.set(event, (handlers.get(event) ?? new Set()).add(h));
    },
    off: (event: string, h: Handler): void => {
      handlers.get(event)?.delete(h);
    },
  };
  const fire = (event: string, params: Record<string, unknown>): void => {
    for (const h of handlers.get(event) ?? []) h(params);
  };
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    if (typeof expr === "string" && expr.includes("document.body")) return 10_000;
    if (typeof expr === "string" && expr.includes("querySelector")) {
      return { matched: false, src: null };
    }
    return null;
  });
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: (): string => url,
    title: vi.fn().mockResolvedValue("Example"),
    evaluate,
    frames: vi.fn().mockReturnValue([]),
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
  return {
    page,
    evaluate,
    emitCapture: async (requestId) => {
      fire("Network.requestWillBeSent", {
        requestId,
        request: { url: `${url}/api/${requestId}`, method: "POST", headers: {} },
      });
      fire("Network.responseReceived", { requestId, response: { status: 200, headers: {} } });
      fire("Network.loadingFinished", { requestId });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function capturedUrls(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { url?: unknown })
    .flatMap((c) => (typeof c.url === "string" ? [c.url] : []));
}

describe("recon-browser CLI/main — rebinds to the page a step opened", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-new-tab-rebind-"));
    process.env.RECON_RUN_ID = "20260902-000000-newtabrebind";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingStub.mockReset();
    executeNavigateStepStub.mockReset();
    vi.mocked(createBrowserSession).mockReset();
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
  });

  it("runs step 2 on the opened page and records captures emitted by it", async () => {
    const a = makeFakePage("https://example.com/a");
    const b = makeFakePage("https://example.com/b");
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand: { context: { awaitActivePage: async (): Promise<Page> => a.page } },
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    const stepPages: Page[] = [];
    let step2Evaluated = false;
    executeStepWithHealingStub.mockImplementation(async (args: Record<string, unknown>) => {
      stepPages.push(args.page as Page);
      if (stepPages.length === 1) {
        (args.onPageAdopted as (p: Page) => void)(b.page);
        await b.emitCapture("req-b");
        return "completed";
      }
      const frameTarget = args.frameTarget as { evaluate: (expr: string) => Promise<unknown> };
      b.evaluate.mockClear();
      a.evaluate.mockClear();
      await frameTarget.evaluate("1");
      step2Evaluated = b.evaluate.mock.calls.length > 0 && a.evaluate.mock.calls.length === 0;
      return "completed";
    });

    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://example.com/a",
      "--flow",
      JSON.stringify([
        { step: "click the link that opens a new tab" },
        { step: "fill the field on the new tab" },
      ]),
    ];

    await main();

    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);
    expect(stepPages[0]).toBe(a.page);
    expect(stepPages[1]).toBe(b.page);
    expect(step2Evaluated).toBe(true);
    expect(capturedUrls(runsRoot)).toContain("https://example.com/b/api/req-b");
  });
});
