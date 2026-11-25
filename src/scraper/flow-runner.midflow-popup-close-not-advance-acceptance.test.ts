import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifyStepAdvancedWithLLM } from "@/lib/llm/judges/verify-step-advanced";
import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/verify-step-advanced", () => ({
  verifyStepAdvancedWithLLM: vi.fn(),
}));
vi.mock("@/lib/llm/judges/verify-submit", () => ({
  verifySubmitWithLLM: vi.fn(),
}));

const URL_ = "https://wizard.example.test/apply/profile";
const SAVE_STEP =
  "Click the 'Save and Continue' button to save the profile and advance to the next step";
const REJECTION =
  "The page still shows 'current step 1 of 7' and the same form fields with the Save and Continue button, indicating no progression to the next step.";

interface WorldState {
  url: string;
  html: number;
  text: string;
  markers: number;
  clicks: number;
  popupOpen: boolean;
  fieldValue: string;
  content: string;
}

function makeWorld(
  opts: {
    selectorFor?: string;
    onClick?: (s: WorldState) => void;
    extraEvaluate?: (src: string, s: WorldState) => unknown;
  } = {}
) {
  const state: WorldState = {
    url: URL_,
    html: 40_000,
    text: "current step 1 of 7 Profile First name Last name Save and Continue",
    markers: 0,
    clicks: 0,
    popupOpen: false,
    fieldValue: "",
    content: "current step 1 of 7 Profile First name Last name Save and Continue",
  };
  const session = { on: () => {}, off: () => {} };
  const page = {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      const extra = opts.extraEvaluate?.(src, state);
      if (extra !== undefined) return extra;
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return {
          html: state.html,
          text: `${state.text.length}:${state.text}`,
          values: "v",
          content: state.content,
        };
      }
      if (src.includes("isInvalid(el)")) return state.markers;
      if (src.includes("document.body.innerText")) return state.text;
      return null;
    },
    url: () => state.url,
    title: async () => "Profile | Wizard",
    locator: () => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => state.fieldValue,
      }),
    }),
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
  const act = vi.fn().mockImplementation(async () => {
    state.clicks += 1;
    opts.onClick?.(state);
    return {
      success: true,
      message: "clicked",
      actionDescription: "clicked",
      actions: [
        {
          selector: opts.selectorFor ?? "css=[data-automation-id=saveContinue]",
          description: "Save and Continue",
          method: "click",
        },
      ],
    };
  });
  const stagehand = {
    act,
    observe: vi
      .fn()
      .mockImplementation(async (i?: unknown) =>
        typeof i === "string" ? [] : [{ selector: "xpath=//probe-presence", description: "p" }]
      ),
  } as unknown as Stagehand;
  return { state, page, stagehand, act };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function params(world: ReturnType<typeof makeWorld>, step: string, trajectory: unknown[]): never {
  return {
    stagehand: world.stagehand,
    page: world.page,
    step,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 0,
    totalSteps: () => 3,
    phase: "flow",
    signalCounter: { n: 0 },
    trajectory,
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: {},
    rephraseModel: null,
    logger,
    uploadFixture: null,
    isFinalStep: false,
    flowHasSubmitSemantics: false,
    submitEndpointPattern: null,
    submittedStateSelectors: [],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: null,
    successUrlFragments: [],
    successPageTitleHints: [],
    ownBackendHostnames: [],
    knownErrorClassPrefixes: [],
    wizardExitButtonLabels: [],
  } as never;
}

async function run(world: ReturnType<typeof makeWorld>, step = SAVE_STEP) {
  const trajectory: unknown[] = [];
  const outcome = await executeStepWithHealing(params(world, step, trajectory)).catch(
    () => "threw" as const
  );
  return { outcome, trajectory };
}

describe("flow-runner/executeStepWithHealing — popup closing under a mid-flow Save and Continue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyStepAdvancedWithLLM).mockResolvedValue({
      advanced: false,
      reason: REJECTION,
    });
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: false,
      reason: REJECTION,
    } as never);
  });

  it("does not credit a click that only closed a popup", async () => {
    const world = makeWorld({
      onClick: (s) => {
        s.html -= 3000;
        s.text = "current step 1 of 7 Profile First name Last name Save and Continue";
      },
    });
    world.state.text += ` ${Array.from({ length: 60 }, (_, i) => `Country ${i} code`).join(" ")}`;
    const { outcome } = await run(world);
    expect(outcome).not.toBe("completed");
  });
  it("credits a page advance that also closed a popup", async () => {
    const world = makeWorld({
      onClick: (s) => {
        s.html += 9000;
        s.text = "current step 2 of 7 Work history Employer Title Dates Save and Continue";
        s.content = s.text;
      },
    });
    world.state.text += ` ${Array.from({ length: 60 }, (_, i) => `Country ${i} code`).join(" ")}`;
    const { outcome } = await run(world);
    expect(outcome).toBe("completed");
  });
});
