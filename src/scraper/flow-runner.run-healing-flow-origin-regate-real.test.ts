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
const BODY_LENGTH_EXPR = "document.body ? document.body.outerHTML.length : 0";

function step(index: number): HealingFlowStep {
  return {
    instruction: `Fill in field ${index}`,
    optional: false,
    upload: false,
    submitStep: false,
  };
}

describe("flow-runner/runHealingFlow — origin re-gate with the real helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedObserve.mockResolvedValue([ACTION]);
  });

  it("reloads once after a cross-origin hop so the next step sees the rendered body", async () => {
    const urls = { current: "https://app.example.com/a" };
    const state = { rendered: true };
    const bodyAtStep: boolean[] = [];
    const reload = vi.fn().mockImplementation(async () => {
      state.rendered = true;
    });
    const page = {
      url: () => urls.current,
      title: vi.fn().mockResolvedValue("Apply"),
      evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
        if (expr === BODY_LENGTH_EXPR) return state.rendered ? 9000 : 10;
        return { html: 0, text: "0:" };
      }),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      frames: () => [],
      getSessionForFrame: () => ({ on: vi.fn(), off: vi.fn() }),
      mainFrameId: () => "main",
      sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
      reload,
    } as unknown as Page;
    guardedObserve.mockImplementation(async () => {
      bodyAtStep.push(state.rendered);
      return [ACTION];
    });
    let acts = 0;
    guardedAct.mockImplementation(async () => {
      acts += 1;
      if (acts === 1) {
        urls.current = "https://login.example.net/x";
        state.rendered = false;
      }
      return { success: true, message: "acted", actionDescription: "c", actions: [ACTION] };
    });
    const stagehand = {
      context: { pages: () => [page], setActivePage: vi.fn() },
    } as unknown as Stagehand;

    await runHealingFlow({
      stagehand,
      page,
      steps: [step(0), step(1)],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    }).catch(() => undefined);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(bodyAtStep.length).toBeGreaterThanOrEqual(2);
    expect(bodyAtStep[1]).toBe(true);
  });

  async function runHops(hops: string[], rendered: boolean): Promise<ReturnType<typeof vi.fn>> {
    const urls = { current: "https://app.example.com/a" };
    const reload = vi.fn().mockResolvedValue(undefined);
    const page = {
      url: () => urls.current,
      title: vi.fn().mockResolvedValue("Apply"),
      evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
        if (expr === BODY_LENGTH_EXPR) return rendered ? 9000 : 10;
        return { html: 0, text: "0:" };
      }),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      frames: () => [],
      getSessionForFrame: () => ({ on: vi.fn(), off: vi.fn() }),
      mainFrameId: () => "main",
      sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
      reload,
    } as unknown as Page;
    let acts = 0;
    guardedAct.mockImplementation(async () => {
      urls.current = hops[Math.min(acts, hops.length - 1)] ?? urls.current;
      acts += 1;
      return { success: true, message: "acted", actionDescription: "c", actions: [ACTION] };
    });
    const stagehand = {
      context: { pages: () => [page], setActivePage: vi.fn() },
    } as unknown as Stagehand;
    await runHealingFlow({
      stagehand,
      page,
      steps: [step(0), step(1)],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
    }).catch(() => undefined);
    return reload;
  }

  it("does not reload after a cross-origin hop onto a hydrated page", async () => {
    const reload = await runHops(["https://login.example.net/x"], true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload on same-origin steps even when the body is tiny", async () => {
    const reload = await runHops(["https://app.example.com/b", "https://app.example.com/c"], false);
    expect(reload).not.toHaveBeenCalled();
  });
});
