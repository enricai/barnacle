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

function transitionBody(type: string): string {
  return JSON.stringify({ operationName: "TransitionWorklet", variables: { input: { type } } });
}

type Handler = (params: Record<string, unknown>) => void;

function makeFakePage(): {
  page: Page;
  emitMutation: (requestId: string, body?: string) => Promise<void>;
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
  const defaultBody = transitionBody("next");
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
    emitMutation: async (requestId, body = defaultBody) => {
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

  type Emit = (fake: ReturnType<typeof makeFakePage>, i: number) => Promise<void>;
  type Seen = { files: number; advance: boolean; dir: string };

  // Mutations are emitted from the test body, outside withRuntimeCaptureStore's async scope,
  // so a sink that resolves its store ambiently would drop them.
  async function runWithOutsideEmits(emits: Emit[]): Promise<Seen[]> {
    const fakes = emits.map(() => makeFakePage());
    const seen: Seen[] = [];
    const ready = fakes.map(() => Promise.withResolvers<void>());
    const emitted = fakes.map(() => Promise.withResolvers<void>());
    fakes.forEach((_, i) => {
      guardedObserve.mockImplementationOnce(async () => {
        ready[i]?.resolve();
        await emitted[i]?.promise;
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
    });
    const runs = Promise.all(
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
    await Promise.all(ready.map((r) => r.promise));
    for (const [i, fake] of fakes.entries()) {
      await emits[i]?.(fake, i);
      emitted[i]?.resolve();
    }
    await runs;
    return seen;
  }

  it("feeds window detectors with out-of-scope captures, isolated per concurrent run", async () => {
    const seen = await runWithOutsideEmits([
      async (fake) => fake.emitMutation("req-0-0"),
      async (fake) => {
        await fake.emitMutation("req-1-0");
        await fake.emitMutation("req-1-1");
      },
    ]);

    expect(seen[0]?.advance).toBe(true);
    expect(seen[1]?.advance).toBe(true);
    expect(seen[0]?.files).toBe(1);
    expect(seen[1]?.files).toBe(2);
    expect(seen[0]?.dir).not.toBe(seen[1]?.dir);
    expect(seen[0]?.dir.startsWith("memory:")).toBe(true);
  });

  it("detects next as an advance but not back", async () => {
    const seen = await runWithOutsideEmits([
      async (fake) => fake.emitMutation("req-next", transitionBody("next")),
      async (fake) => fake.emitMutation("req-back", transitionBody("back")),
    ]);

    expect(seen[0]?.advance).toBe(true);
    expect(seen[1]?.advance).toBe(false);
    expect(seen[1]?.files).toBe(1);
  });

  it("detects an advance that follows an autosave POST", async () => {
    const seen = await runWithOutsideEmits([
      async (fake) => {
        await fake.emitMutation(
          "req-save",
          JSON.stringify({ operationName: "AutosaveDraft", variables: { input: { draft: 1 } } })
        );
        await fake.emitMutation("req-next", transitionBody("next"));
      },
    ]);

    expect(seen[0]?.files).toBe(2);
    expect(seen[0]?.advance).toBe(true);
  });
});
