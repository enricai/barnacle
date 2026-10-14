import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

vi.mock("@/scraper/session", () => ({
  createBrowserSession: vi.fn(),
}));

const guardedObserve = vi.fn();
const guardedAct = vi.fn();

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
    guardedAct: (...args: unknown[]) => guardedAct(...args),
  };
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const ACTION = { selector: "input#f", description: "field", method: "fill" };

function step(index: number): HealingFlowStep {
  return {
    instruction: `Fill in field ${index}`,
    optional: false,
    upload: false,
    submitStep: false,
  };
}

type Handler = (params: Record<string, unknown>) => void;

function makeFakePage(urls: { current: string }): {
  page: Page;
  emit: (event: string, params: Record<string, unknown>) => void;
  listenerCount: () => number;
  urlReads: () => number;
  wiredCount: () => number;
  emitCapture: (requestId: string) => Promise<void>;
  bodyFetches: () => number;
} {
  const handlers = new Map<string, Set<Handler>>();
  let reads = 0;
  let wired = 0;
  const session = {
    on: (event: string, h: Handler) => {
      wired += 1;
      handlers.set(event, (handlers.get(event) ?? new Set()).add(h));
    },
    off: (event: string, h: Handler) => {
      handlers.get(event)?.delete(h);
    },
  };
  const sendCDP = vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false });
  const page = {
    url: () => {
      reads += 1;
      return urls.current;
    },
    title: vi.fn().mockResolvedValue("Apply"),
    evaluate: vi.fn().mockResolvedValue({ html: 0, text: "0:" }),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    frames: () => [],
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP,
  } as unknown as Page;
  const fire = (event: string, params: Record<string, unknown>): void => {
    for (const h of handlers.get(event) ?? []) h(params);
  };
  return {
    page,
    bodyFetches: () =>
      sendCDP.mock.calls.filter(([method]) => method === "Network.getResponseBody").length,
    emitCapture: async (requestId) => {
      fire("Network.requestWillBeSent", {
        requestId,
        request: { url: `${urls.current}/api/${requestId}`, method: "POST", headers: {} },
      });
      fire("Network.responseReceived", { requestId, response: { status: 200, headers: {} } });
      fire("Network.loadingFinished", { requestId });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    emit: (event, params) => {
      for (const h of handlers.get(event) ?? []) h(params);
    },
    listenerCount: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
    urlReads: () => reads,
    wiredCount: () => wired,
  };
}

describe("flow-runner/runHealingFlow — new tab rebinding of capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records captures emitted by the opened page and keeps driving it", async () => {
    const urlsA = { current: "https://example.org/a" };
    const urlsB = { current: "https://example.org/b" };
    const a = makeFakePage(urlsA);
    const b = makeFakePage(urlsB);
    const pages: Page[] = [a.page];
    const stagehand = {
      context: {
        pages: () => [...pages],
        setActivePage: vi.fn(),
      },
    } as unknown as Stagehand;

    guardedObserve.mockResolvedValue([ACTION]);
    guardedAct.mockImplementation(async (_sh: unknown, input: unknown) => {
      const opensTab = typeof input === "string" && input.includes("field 0");
      if (opensTab && !pages.includes(b.page)) {
        pages.push(b.page);
        urlsB.current = "https://example.org/b/opened";
      }
      return {
        success: true,
        message: "acted",
        actionDescription: "clicked",
        actions: [ACTION],
      };
    });

    const bFetchesAtStep2: number[] = [];
    const origObserve = guardedObserve.getMockImplementation();
    guardedObserve.mockImplementation(async (...args: unknown[]) => {
      if (pages.includes(b.page) && bFetchesAtStep2.length === 0) {
        await b.emitCapture("req-b");
        bFetchesAtStep2.push(b.bodyFetches());
      }
      return origObserve ? origObserve(...args) : [ACTION];
    });

    await runHealingFlow({
      stagehand,
      page: a.page,
      steps: [step(0), step(1)],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    }).catch(() => undefined);

    expect(stagehand.context.setActivePage).toHaveBeenCalledWith(b.page);
    expect(bFetchesAtStep2).toEqual([1]);
    expect(b.listenerCount()).toBe(0);
    expect(a.listenerCount()).toBe(0);
  });
});
