import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type HealingFlowStep,
  runHealingFlow,
  windowHasAdvanceTransition,
} from "@/scraper/flow-runner";
import { defaultCapturesDir, listCaptureFiles } from "@/scraper/runtime-capture-store";
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
const PATTERN = "TransitionWorklet";

const STEP: HealingFlowStep = {
  instruction: "Fill in field 0",
  optional: false,
  upload: false,
  submitStep: false,
};

type Handler = (params: Record<string, unknown>) => void;

function makeFakePage(): {
  page: Page;
  emitMutation: (requestId: string) => Promise<void>;
} {
  const handlers = new Map<string, Set<Handler>>();
  const session = {
    on: (event: string, h: Handler) => {
      handlers.set(event, (handlers.get(event) ?? new Set()).add(h));
    },
    off: (event: string, h: Handler) => {
      handlers.get(event)?.delete(h);
    },
  };
  const body = JSON.stringify({
    operationName: "TransitionWorklet",
    variables: { input: { type: "next" } },
  });
  const page = {
    url: () => "https://example.org/a",
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
  const fire = (event: string, params: Record<string, unknown>): void => {
    for (const h of handlers.get(event) ?? []) h(params);
  };
  return {
    page,
    emitMutation: async (requestId) => {
      fire("Network.requestWillBeSent", {
        requestId,
        request: {
          url: "https://example.org/gq",
          method: "POST",
          headers: {},
          postData: body,
        },
      });
      fire("Network.responseReceived", { requestId, response: { status: 200, headers: {} } });
      fire("Network.loadingFinished", { requestId });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function makeStagehand(page: Page): Stagehand {
  return {
    context: { pages: () => [page], setActivePage: vi.fn() },
  } as unknown as Stagehand;
}

describe("flow-runner/runHealingFlow — runtime capture store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedAct.mockResolvedValue({
      success: true,
      message: "acted",
      actionDescription: "clicked",
      actions: [ACTION],
    });
  });

  it("feeds window detectors with in-run captures, isolated per concurrent run", async () => {
    const fakes = [makeFakePage(), makeFakePage()];
    const seen: Array<{ files: number; advance: boolean; dir: string }> = [];
    const runs = fakes.map((fake, i) => {
      guardedObserve.mockImplementationOnce(async () => {
        // i-th run emits i captures so counts reveal any cross-run leakage
        for (let n = 0; n <= i; n += 1) await fake.emitMutation(`req-${i}-${n}`);
        const dir = defaultCapturesDir();
        seen[i] = {
          files: listCaptureFiles(dir).length,
          advance: windowHasAdvanceTransition({
            preIdx: -1,
            advanceTransitionBodyPattern: PATTERN,
          }),
          dir,
        };
        return [ACTION];
      });
      return null;
    });
    expect(runs).toHaveLength(2);

    await Promise.all(
      fakes.map((fake) =>
        runHealingFlow({
          stagehand: makeStagehand(fake.page),
          page: fake.page,
          steps: [STEP],
          logger: testLogger,
          anthropic: null,
          rephraseModel: null,
          uploadFixture: null,
        }).catch(() => undefined)
      )
    );

    expect(seen[0].advance).toBe(true);
    expect(seen[1].advance).toBe(true);
    expect(seen[0].files).toBe(1);
    expect(seen[1].files).toBe(2);
    expect(seen[0].dir).not.toBe(seen[1].dir);
    expect(seen[0].dir.startsWith("memory:")).toBe(true);
  });
});
