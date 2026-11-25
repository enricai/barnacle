import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifyStepAdvancedWithLLM } from "@/lib/llm/judges/verify-step-advanced";
import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Acceptance regression: a mid-flow "Save and Continue" click that the
 * outcome judge explicitly rejected, with zero network and zero URL change and
 * only a weak client-side reveal (small text growth plus aria-invalid /
 * error-message-hook markers), must not be credited as a page advance. An
 * unavailable judge keeps today's credit, and a settled advance with no
 * marker growth is still credited. Made-up generic wizard fixtures only.
 */

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
  };
  const session = { on: () => {}, off: () => {} };
  const page = {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      const extra = opts.extraEvaluate?.(src, state);
      if (extra !== undefined) return extra;
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return { html: state.html, text: `${state.text.length}:${state.text}`, values: "v" };
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

/** A weak client-side reveal: a short error line appears, validation markers grow, nothing else moves. */
function weakReveal(s: WorldState): void {
  s.html += 900;
  s.text += " Please enter a value in this field.";
  s.markers = 2;
}

async function run(world: ReturnType<typeof makeWorld>, step = SAVE_STEP) {
  const trajectory: unknown[] = [];
  const outcome = await executeStepWithHealing(params(world, step, trajectory)).catch(
    () => "threw" as const
  );
  return { outcome, trajectory };
}

describe("flow-runner/executeStepWithHealing — judge-rejected mid-flow Save and Continue on a weak signal", () => {
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

  it("does not credit a judge-rejected click whose only evidence is a small reveal with grown aria-invalid/error-hook markers", async () => {
    const world = makeWorld({ onClick: weakReveal });
    const { outcome, trajectory } = await run(world);

    expect(outcome).not.toBe("completed");
    expect(trajectory).toHaveLength(0);
    expect(world.state.clicks).toBeGreaterThan(0);
    expect(world.state.url).toBe(URL_);
    expect(world.state.markers).toBe(2);
  });

  it("keeps today's credit when the judge is unavailable (null verdict) on a settled advance with no marker growth", async () => {
    vi.mocked(verifyStepAdvancedWithLLM).mockResolvedValue(null as never);
    vi.mocked(verifySubmitWithLLM).mockResolvedValue(null as never);
    const world = makeWorld({
      onClick: (s) => {
        s.html += 900;
        s.text = "current step 2 of 7 Work history Employer Title Save and Continue";
      },
    });
    const { outcome, trajectory } = await run(world);

    expect(outcome).toBe("completed");
    expect(trajectory).toHaveLength(1);
    expect(world.state.markers).toBe(0);
  });

  it("still credits a settled advance with no marker growth even when the judge rejected", async () => {
    const world = makeWorld({
      onClick: (s) => {
        s.html += 30_000;
        s.text = "current step 2 of 7 Work history Employer Title Save and Continue";
      },
    });
    const { outcome, trajectory } = await run(world);

    expect(outcome).toBe("completed");
    expect(trajectory).toHaveLength(1);
    expect(world.state.markers).toBe(0);
  });
});

describe("flow-runner/executeStepWithHealing — select popup opened with the field value unchanged", () => {
  const SELECT_STEP = "In the 'Preferred Contact Method' dropdown, select 'Email'";
  const WIDGET = "xpath=//*[@id='contact-widget']";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyStepAdvancedWithLLM).mockResolvedValue({ advanced: true, reason: "ok" });
  });

  it("does not view-swap-credit a popup-open click that committed no value", async () => {
    const world = makeWorld({
      selectorFor: WIDGET,
      onClick: (s) => {
        s.popupOpen = true;
        s.html += 12_000;
        s.text += ` ${Array.from({ length: 30 }, (_, i) => `Contact Option ${i} long label`).join(" ")}`;
      },
      extraEvaluate: (src) =>
        src.includes("isPromptWidget") ? { isPromptWidget: true, committed: false } : undefined,
    });
    const { outcome, trajectory } = await run(world, SELECT_STEP);

    expect(world.state.popupOpen).toBe(true);
    expect(world.state.fieldValue).toBe("");
    expect(outcome).not.toBe("completed");
    expect(trajectory).toHaveLength(0);
  });
});
