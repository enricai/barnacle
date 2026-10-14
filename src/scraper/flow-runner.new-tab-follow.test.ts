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

type Opener = "anchor" | "window-open" | "none";

async function runWith(opener: Opener): Promise<{
  a: ReturnType<typeof makeFakePage>;
  b: ReturnType<typeof makeFakePage>;
  setActivePage: ReturnType<typeof vi.fn>;
  actInputs: string[];
}> {
  const a = makeFakePage({ current: "https://example.com/a" });
  const b = makeFakePage({ current: "https://example.com/b" });
  const pages: Page[] = [a.page];
  const setActivePage = vi.fn();
  const stagehand = { context: { pages: () => [...pages], setActivePage } } as unknown as Stagehand;
  const actInputs: string[] = [];

  guardedObserve.mockResolvedValue([ACTION]);
  guardedAct.mockImplementation(async (_sh: unknown, input: unknown) => {
    actInputs.push(String(input));
    const isOpener = String(input).includes("field 0");
    if (isOpener && opener !== "none" && !pages.includes(b.page)) pages.push(b.page);
    return { success: true, message: "acted", actionDescription: "clicked", actions: [ACTION] };
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
  return { a, b, setActivePage, actInputs };
}

describe("flow-runner new-tab follow acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["anchor target=_blank", "anchor" as const],
    ["window.open", "window-open" as const],
  ])("%s click leaves the run on the opened page with captures wired to it", async (_n, opener) => {
    const { a, b, setActivePage, actInputs } = await runWith(opener);
    expect(setActivePage).toHaveBeenCalledWith(b.page);
    expect(actInputs.length).toBeGreaterThan(1);
    expect(b.urlReads()).toBeGreaterThan(0);
    expect(b.wiredCount()).toBeGreaterThan(0);
    expect(a.listenerCount()).toBe(0);
    expect(b.listenerCount()).toBe(0);
  });

  it("keeps the original page when a click opens no new page", async () => {
    const { a, b, setActivePage } = await runWith("none");
    expect(setActivePage).not.toHaveBeenCalledWith(b.page);
    expect(b.urlReads()).toBe(0);
    expect(b.wiredCount()).toBe(0);
    expect(a.urlReads()).toBeGreaterThan(0);
    expect(a.listenerCount()).toBe(0);
  });
});
