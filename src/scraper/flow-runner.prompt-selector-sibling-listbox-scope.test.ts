import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

/**
 * Pins required_item 3: on a page with several independent Yes/No-shaped
 * prompt-selector widgets, opening one widget's popup and enumerating its
 * options must never include a SIBLING widget's rendered option nodes — even
 * when the sibling offers options with IDENTICAL text ("Yes"/"No") and even
 * when the sibling's own popup is already open/mounted in the DOM (stale
 * marks and simultaneous listboxes both present at once).
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function baseParams(page: Page, stagehand: Stagehand, step: string, frameTarget: unknown) {
  return {
    stagehand,
    page,
    frameTarget,
    step,
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

const widgetGroup = (id: string, label: string, section: string): string => `
  <div role="group" aria-labelledby="${section}">
    <span id="${section}">${label}</span>
    <div data-automation-id="formField-${id}">
      <label for="${id}--input"><span>${label}</span></label>
      <div id="${id}" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer" aria-invalid="true">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="${id}--input" data-uxi-widget-type="selectinput" type="text"
               aria-required="true" value="" />
      </div>
    </div>
  </div>`;

// Two independent widgets, each offering the SAME "Yes"/"No" option text.
const TWO_YES_NO_WIDGET_HTML = `
<div data-automation-id="applyFlowMyInfoPage">
  ${widgetGroup("wA", "Are you authorized to work in the US?", "secA")}
  ${widgetGroup("wB", "Do you require visa sponsorship?", "secB")}
</div>`;

describe("flow-runner/tryPromptSelectorPrimitive sibling listbox scope isolation (identical option text)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves widget B's option from its OWN aria-owns/aria-controls listbox, not sibling widget A's, while A's popup is left open/mounted", async () => {
    const stagehandAct = vi.fn();
    const stagehand = {
      act: stagehandAct,
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;
    const { page, target, window } = buildPromptWidgetHarness({
      html: TWO_YES_NO_WIDGET_HTML,
      popupByWidgetId: {
        wA: { options: ["Yes", "No"], portaled: true, keepPopupMounted: true },
        wB: { options: ["Yes", "No"], portaled: true, keepPopupMounted: true },
      },
    });

    // Widget A: select "Yes" first, and LEAVE its popup (and marked option
    // nodes) mounted in the DOM — mirrors a stale/still-open sibling popup.
    const trajA: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const stepA = {
      ...baseParams(
        page as unknown as Page,
        stagehand,
        "for 'Are you authorized to work in the US?' select 'Yes'",
        target
      ),
      trajectory: trajA,
    };
    const resultA = await executeStepWithHealing(stepA as never);
    expect(resultA).toBe("completed");
    expect(trajA).toEqual([{ stepIndex: 3, verifiedBy: "dom", targetId: "wA" }]);

    // Widget B: select "No" — the widget A popup (with its own "Yes"/"No"
    // options, sharing identical text) is still mounted in the document.
    const trajB: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const stepB = {
      ...baseParams(
        page as unknown as Page,
        stagehand,
        "for 'Do you require visa sponsorship?' select 'No'",
        target
      ),
      stepIndex: 4,
      trajectory: trajB,
    };
    const resultB = await executeStepWithHealing(stepB as never);

    expect(resultB).toBe("completed");
    // Resolved and committed widget B, never widget A's opener/options.
    expect(trajB).toEqual([{ stepIndex: 4, verifiedBy: "dom", targetId: "wB" }]);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('selected "No" for option "No"')
    );

    // Widget B's own value node committed "No"; widget A's committed value
    // from the earlier step ("Yes") is untouched by widget B's selection.
    const document = window.document;
    const wAValue = document
      .getElementById("wA")
      ?.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent;
    const wBValue = document
      .getElementById("wB")
      ?.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent;
    expect(wAValue).toBe("Yes");
    expect(wBValue).toBe("No");

    // The marked "No" option that got committed lives inside widget B's OWN
    // portaled popup (id `portal-wB`), never widget A's still-mounted popup.
    // Both of widget B's own scoped options ("Yes" and "No") carry the mark
    // (enumeration marks every option in scope, not just the chosen one), so
    // disambiguate the COMMITTED one by its own text.
    const markedOptions = Array.from(
      document.querySelectorAll("[data-bcl-prompt-opt-idx][data-automation-id='promptOption']")
    );
    const committedOption = markedOptions.find((el) => el.textContent?.trim() === "No");
    expect(committedOption).toBeDefined();
    const ownerPopup = committedOption?.closest("[data-test-popup-for]");
    expect(ownerPopup?.getAttribute("data-test-popup-for")).toBe("wB");
    // No marked option from widget A's still-mounted popup survived — the
    // cross-call mark-clear runs document-wide before widget B's own marks.
    const ownerPopupsSeen = new Set(
      markedOptions.map((el) =>
        el.closest("[data-test-popup-for]")?.getAttribute("data-test-popup-for")
      )
    );
    expect(ownerPopupsSeen).toEqual(new Set(["wB"]));
  });

  it("keeps INLINE (no aria-owns/aria-controls) widgets' options scoped to their own subtree, not a sibling's inline popup", async () => {
    const stagehandAct = vi.fn();
    const stagehand = {
      act: stagehandAct,
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;
    // Neither widget declares aria-owns/aria-controls; both render inline —
    // proves the inline-subtree branch doesn't fall through to a document-
    // wide query that would silently pass with only one widget on the page.
    const { page, target, window } = buildPromptWidgetHarness({
      html: TWO_YES_NO_WIDGET_HTML,
      popupByWidgetId: {
        wA: { options: ["Yes", "No"], keepPopupMounted: true },
        wB: { options: ["Yes", "No"], keepPopupMounted: true },
      },
    });

    const trajA: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const stepA = {
      ...baseParams(
        page as unknown as Page,
        stagehand,
        "for 'Are you authorized to work in the US?' select 'Yes'",
        target
      ),
      trajectory: trajA,
    };
    const resultA = await executeStepWithHealing(stepA as never);
    expect(resultA).toBe("completed");
    expect(trajA).toEqual([{ stepIndex: 3, verifiedBy: "dom", targetId: "wA" }]);

    const trajB: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const stepB = {
      ...baseParams(
        page as unknown as Page,
        stagehand,
        "for 'Do you require visa sponsorship?' select 'No'",
        target
      ),
      stepIndex: 4,
      trajectory: trajB,
    };
    const resultB = await executeStepWithHealing(stepB as never);

    expect(resultB).toBe("completed");
    expect(trajB).toEqual([{ stepIndex: 4, verifiedBy: "dom", targetId: "wB" }]);

    const document = window.document;
    const wAValue = document
      .getElementById("wA")
      ?.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent;
    const wBValue = document
      .getElementById("wB")
      ?.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent;
    expect(wAValue).toBe("Yes");
    expect(wBValue).toBe("No");

    // The committed "No" option's ancestor is widget B itself (`#wB`), not
    // widget A's still-mounted inline subtree. Both of widget B's own
    // options carry the enumeration mark, so pick the COMMITTED one by text.
    const markedOptions = Array.from(
      document.querySelectorAll("[data-bcl-prompt-opt-idx][data-automation-id='promptOption']")
    );
    const committedOption = markedOptions.find((el) => el.textContent?.trim() === "No");
    expect(committedOption).toBeDefined();
    expect(committedOption?.closest("#wB")).not.toBeNull();
    expect(committedOption?.closest("#wA")).toBeNull();
    // No marked option came from widget A's still-mounted inline subtree.
    expect(markedOptions.every((el) => el.closest("#wA") === null)).toBe(true);
  });
});
