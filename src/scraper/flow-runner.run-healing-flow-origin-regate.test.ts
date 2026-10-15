import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

const regate = vi.fn();

vi.mock("@/scraper/spa-readiness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/spa-readiness")>();
  return {
    ...actual,
    regateSpaAfterOriginChange: (...args: unknown[]) => regate(...args),
  };
});

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
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
  return {
    page,
    emit: (event, params) => {
      for (const h of handlers.get(event) ?? []) h(params);
    },
    listenerCount: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
    urlReads: () => reads,
    wiredCount: () => wired,
  };
}


function runWith(page: Page, stagehand: Stagehand): Promise<unknown> {
  return runHealingFlow({
    stagehand,
    page,
    steps: [step(0), step(1), step(2)],
    logger: testLogger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
  }).catch(() => undefined);
}

function stagehandFor(page: Page): Stagehand {
  return {
    context: { pages: () => [page], setActivePage: vi.fn() },
  } as unknown as Stagehand;
}

describe("flow-runner/runHealingFlow — origin re-gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedObserve.mockResolvedValue([ACTION]);
  });

  it("re-gates once when a step hops origin, before the next step runs", async () => {
    const urls = { current: "https://app.example.com/a" };
    const { page } = makeFakePage(urls);
    const order: string[] = [];
    regate.mockImplementation(async () => {
      order.push("regate");
    });
    guardedAct.mockImplementation(async () => {
      order.push("act");
      urls.current = "https://login.example.net/x";
      return { success: true, message: "acted", actionDescription: "c", actions: [ACTION] };
    });
    await runWith(page, stagehandFor(page));
    expect(regate).toHaveBeenCalledTimes(1);
    expect(regate.mock.calls[0]?.[0]).toBe(page);
    expect(order.slice(0, 2)).toEqual(["act", "regate"]);
  });

  it("does not re-gate on a same-origin sequence", async () => {
    const urls = { current: "https://app.example.com/a" };
    const { page } = makeFakePage(urls);
    let n = 0;
    guardedAct.mockImplementation(async () => {
      n += 1;
      urls.current = `https://app.example.com/a/${n}`;
      return { success: true, message: "acted", actionDescription: "c", actions: [ACTION] };
    });
    await runWith(page, stagehandFor(page));
    expect(regate).not.toHaveBeenCalled();
  });
});
