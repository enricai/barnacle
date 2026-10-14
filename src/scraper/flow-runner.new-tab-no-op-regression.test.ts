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

const FLOW = { anthropic: null, rephraseModel: null, uploadFixture: null, logger: testLogger };

function clickResult(): Record<string, unknown> {
  return { success: true, message: "acted", actionDescription: "clicked", actions: [ACTION] };
}

describe("flow-runner/runHealingFlow — new-tab handling is a no-op when unneeded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("leaves the bound page untouched and never switches pages when the context has one page", async () => {
    const urls = { current: "https://example.org/a" };
    const a = makeFakePage(urls);
    const stagehand = {
      context: { pages: () => [a.page], setActivePage: vi.fn() },
    } as unknown as Stagehand;
    guardedObserve.mockResolvedValue([ACTION]);
    let acts = 0;
    guardedAct.mockImplementation(async () => {
      acts += 1;
      urls.current = `https://example.org/a/${acts}`;
      return clickResult();
    });

    await runHealingFlow({
      stagehand,
      page: a.page,
      steps: [step(0), step(1)],
      ...FLOW,
    }).catch(() => undefined);

    expect(acts).toBeGreaterThan(0);
    expect(stagehand.context.setActivePage).not.toHaveBeenCalled();
    expect(a.urlReads()).toBeGreaterThan(0);
    expect(a.listenerCount()).toBe(0);
  });

  it("adopts an already-known opened tab once: no repeated switch, no duplicate listeners", async () => {
    const urlsA = { current: "https://example.org/a" };
    const urlsB = { current: "https://example.org/b" };
    const a = makeFakePage(urlsA);
    const b = makeFakePage(urlsB);
    const pages: Page[] = [a.page];
    const stagehand = {
      context: { pages: () => [...pages], setActivePage: vi.fn() },
    } as unknown as Stagehand;
    guardedObserve.mockResolvedValue([ACTION]);
    guardedAct.mockImplementation(async (_sh: unknown, input: unknown) => {
      if (typeof input === "string" && input.includes("field 0") && !pages.includes(b.page)) {
        pages.push(b.page);
      }
      return clickResult();
    });

    await runHealingFlow({
      stagehand,
      page: a.page,
      steps: [step(0), step(1), step(2)],
      ...FLOW,
    }).catch(() => undefined);

    expect(stagehand.context.setActivePage).toHaveBeenCalledTimes(1);
    expect(stagehand.context.setActivePage).toHaveBeenCalledWith(b.page);
    expect(b.wiredCount()).toBe(a.wiredCount());
    expect(a.listenerCount()).toBe(0);
    expect(b.listenerCount()).toBe(0);
  });
});
