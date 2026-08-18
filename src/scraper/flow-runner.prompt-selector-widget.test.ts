import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Unit coverage for `tryPromptSelectorPrimitive`'s enumerate/click/filter/
 * select/verify contract, exercised through `executeStepWithHealing` (the
 * primitive itself is module-private) against fake `page`/`target` fixtures
 * — no real browser, mirroring the fake-evaluate scaffolding style used by
 * `flow-runner.prompt-selector-primitive.test.ts` and
 * `flow-runner.deep-locator-scope-widening.test.ts`.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function actResult(overrides: Partial<ActResult> = {}): ActResult {
  return {
    success: true,
    message: "clicked",
    actionDescription: "clicked",
    actions: [],
    ...overrides,
  };
}

/**
 * Fake page whose `evaluate` answers the prompt-selector primitive's widget
 * enumerate, popup-option enumerate (static or searchable), and commit
 * readback passes by inspecting distinguishing substrings in the opaque
 * `expr` string, and answers every OTHER primitive's probe with an
 * absent/zero result so only the prompt-selector primitive can claim the
 * step. `searchable` widgets only render `optionTexts` once `filled` is
 * true, modeling Workday's Country/Region widgets that render nothing (or a
 * different slice) until the search box is typed into.
 */
function fakePromptWidgetPage(params: {
  widgetLabel: string;
  optionTexts: string[];
  searchable: boolean;
  committedAfterClick: boolean;
}): { page: Page; locatorClick: ReturnType<typeof vi.fn>; searchFill: ReturnType<typeof vi.fn> } {
  const locatorClick = vi.fn().mockResolvedValue(undefined);
  const state = { filled: false };
  const searchFill = vi.fn().mockImplementation(async () => {
    state.filled = true;
  });
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("outerHTML")) return { html: 50_000, text: "0:" };
    if (src.includes("wantText")) {
      return { ok: params.committedAfterClick, id: "phoneType-widget" };
    }
    if (src.includes("promptOption")) {
      const optionsVisible = !params.searchable || state.filled;
      return {
        optionsPresent: true,
        searchable: params.searchable,
        options: optionsVisible ? params.optionTexts.map((text, oIdx) => ({ oIdx, text })) : [],
      };
    }
    if (src.includes("promptIcon")) {
      return {
        widgetPresent: true,
        candidates: [{ wIdx: 0, label: params.widgetLabel }],
      };
    }
    if (src.includes("isInvalid(el)")) return 0;
    return null;
  });
  const page = {
    evaluate,
    url: () => "https://acme.wd1.myworkdayjobs.com/en-US/acme/apply/job/1",
    title: vi.fn().mockResolvedValue("Apply"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        click: locatorClick,
        fill: searchFill,
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
  return { page, locatorClick, searchFill };
}

/** Fake page with no prompt-widget markers at all — every probe absent/zero. */
function fakeNoWidgetPage(): Page {
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("outerHTML")) return { html: 50_000, text: "0:" };
    if (src.includes("promptIcon")) return { widgetPresent: false };
    if (src.includes("isInvalid(el)")) return 0;
    return null;
  });
  return {
    evaluate,
    url: () => "https://acme.wd1.myworkdayjobs.com/en-US/acme/apply/job/1",
    title: vi.fn().mockResolvedValue("Apply"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function baseParams(page: Page, stagehandAct: ReturnType<typeof vi.fn>) {
  const stagehand = {
    act: stagehandAct,
    observe: vi.fn().mockResolvedValue([]),
  } as unknown as Stagehand;
  return {
    stagehand,
    page,
    step: "for 'What is your preferred phone type?' select 'Mobile'",
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 3,
    phase: "apply",
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
    captureFn: vi.fn().mockResolvedValue(undefined),
    uploadFixture: null,
    isFinalStep: false,
    submitEndpointPattern: null,
    submittedStateSelectors: [],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: null,
    successUrlFragments: [],
    successPageTitleHints: [],
    ownBackendHostnames: [],
    knownErrorClassPrefixes: [],
    wizardExitButtonLabels: [],
  };
}

describe("flow-runner/tryPromptSelectorPrimitive widget contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a static-list widget by clicking the trigger then the matching promptOption", async () => {
    const stagehandAct = vi.fn();
    const { page, locatorClick } = fakePromptWidgetPage({
      widgetLabel: "What is your preferred phone type?",
      optionTexts: ["Home", "Mobile", "Work"],
      searchable: false,
      committedAfterClick: true,
    });

    const result = await executeStepWithHealing(baseParams(page, stagehandAct));

    expect(result).toBe("completed");
    // Trigger click (opens popup) + matched option click.
    expect(locatorClick).toHaveBeenCalledTimes(2);
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("types the option text into the search box to filter a searchable-list widget before clicking", async () => {
    const stagehandAct = vi.fn();
    const { page, locatorClick, searchFill } = fakePromptWidgetPage({
      widgetLabel: "What is your preferred phone type?",
      optionTexts: ["Mobile"],
      searchable: true,
      committedAfterClick: true,
    });

    const result = await executeStepWithHealing(baseParams(page, stagehandAct));

    expect(result).toBe("completed");
    expect(searchFill).toHaveBeenCalledWith("Mobile");
    // Trigger click + matched option click (the search box fill isn't a click).
    expect(locatorClick).toHaveBeenCalledTimes(2);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("returns null (falls through to cascade) when the page has no prompt-widget structure", async () => {
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const page = fakeNoWidgetPage();
    const stagehand = {
      act: stagehandAct,
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;

    await executeStepWithHealing({ ...baseParams(page, stagehandAct), stagehand }).catch(
      () => undefined
    );

    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("no prompt widget on page")
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("returns null when no option matches the requested text and there is no LLM client to disambiguate", async () => {
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const { page } = fakePromptWidgetPage({
      widgetLabel: "What is your preferred phone type?",
      optionTexts: ["Home", "Work"], // "Mobile" (STEP's target) is absent.
      searchable: false,
      committedAfterClick: true,
    });
    const stagehand = {
      act: stagehandAct,
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;

    const params = baseParams(page, stagehandAct);
    expect(params.anthropic).toBeNull();
    await executeStepWithHealing({ ...params, stagehand }).catch(() => undefined);

    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining("no option match for"));
    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining("no LLM client"));
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("returns a non-null targetId on a resolved selection, which the caller counts as a completed step", async () => {
    const stagehandAct = vi.fn();
    const { page } = fakePromptWidgetPage({
      widgetLabel: "What is your preferred phone type?",
      optionTexts: ["Home", "Mobile", "Work"],
      searchable: false,
      committedAfterClick: true,
    });

    const result = await executeStepWithHealing(baseParams(page, stagehandAct));

    // `tryPromptSelectorPrimitive` returns the widget's DOM id ("phoneType-widget"
    // per the fake readback), pushed onto the trajectory as `targetId`; the
    // caller maps a non-null targetId to a "completed" step outcome.
    expect(result).toBe("completed");
    expect(stagehandAct).not.toHaveBeenCalled();
  });
});

/**
 * Fake page whose `evaluate` answers the `<select>`-enumerate/set/invalid-
 * check exprs `trySelectPrimitive`/`applySelectValue` issue with a single
 * deterministic option match, and answers the prompt-selector primitive's
 * own widget probe with `widgetPresent: false` — modeling a page that has a
 * genuine native `<select>` and NO prompt-widget structure at all, so the
 * select primitive (which runs earlier in the dispatch chain) must claim the
 * step before prompt-selector ever gets a chance to.
 */
function fakeSelectOnlyPage(): Page {
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("outerHTML")) return { html: 50_000, text: "0:" };
    if (src.includes("selectPresent")) {
      return {
        selectPresent: true,
        detMatch: { selIdx: 0, value: "mobile", text: "Mobile", id: "phoneType-select" },
      };
    }
    if (src.includes("desc.set.call")) return { ok: true };
    if (src.includes("isInvalid(node)")) return false;
    if (src.includes("promptIcon")) return { widgetPresent: false };
    if (src.includes("isInvalid(el)")) return 0;
    return null;
  });
  return {
    evaluate,
    url: () => "https://acme.wd1.myworkdayjobs.com/en-US/acme/apply/job/1",
    title: vi.fn().mockResolvedValue("Apply"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

/**
 * Dispatch/counting contract at the `executeStepWithHealing` call site
 * (distinct from `flow-runner.prompt-selector-widget.test.ts`'s coverage of
 * the primitive's own click/select mechanics): asserts a prompt-widget-only
 * fixture is counted as a resolved candidate — logged, pushed onto the
 * trajectory as a `dom`-verified entry with a `targetId`, and returned as
 * "completed" — WITHOUT ever reaching the focused-probe/act-observe cascade
 * the report shows going blind (0 candidates) on these widgets, and without
 * disturbing the existing select/checkbox/radio-before-prompt-selector
 * dispatch order.
 */
describe("flow-runner/executeStepWithHealing dispatch: prompt-selector counts as a resolved candidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs 'resolved by prompt-selector primitive', pushes a dom-verified trajectory entry with targetId, returns completed, and never reaches the probe/cascade", async () => {
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehandAct = vi.fn();
    const { page } = fakePromptWidgetPage({
      widgetLabel: "What is your preferred phone type?",
      optionTexts: ["Home", "Mobile", "Work"],
      searchable: false,
      committedAfterClick: true,
    });
    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const params = baseParams(page, stagehandAct);
    params.stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;

    const result = await executeStepWithHealing({ ...params, trajectory } as never);

    expect(result).toBe("completed");
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
    expect(trajectory).toEqual([{ stepIndex: 3, verifiedBy: "dom", targetId: "phoneType-widget" }]);
    // The focused-probe-before-attempts path (the report's "focused probe
    // found 0 candidates but unfocused observe found N" symptom) and the
    // act/observe cascade never ran for this step.
    expect(testLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("focused probe"));
    expect(testLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("probe-absent"));
    expect(stagehandObserve).not.toHaveBeenCalled();
    expect(stagehandAct).not.toHaveBeenCalled();
  });

  it("does not shadow the select primitive: a page with a genuine <select> and no prompt-widget structure still resolves via 'resolved by select primitive', not prompt-selector", async () => {
    const stagehandAct = vi.fn();
    const page = fakeSelectOnlyPage();
    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const params = baseParams(page, stagehandAct);

    const result = await executeStepWithHealing({ ...params, trajectory } as never);

    expect(result).toBe("completed");
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by select primitive")
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
    expect(trajectory).toEqual([{ stepIndex: 3, verifiedBy: "dom", targetId: "phoneType-select" }]);
  });
});
