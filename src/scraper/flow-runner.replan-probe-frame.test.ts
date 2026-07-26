import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { makeFakeDeepLocator, registerDeepLocatorHop } from "@/scraper/deep-locator-fake";
import { extractLivePageFormEvidence, probeStepBeforeAttempts } from "@/scraper/flow-runner";
import { type FrameTarget, mainFrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for the leaf-invalid replan probe's frame scoping:
 * `extractLivePageFormEvidence` must probe whichever `FrameTarget` its
 * caller resolved (main or a declared `frameSelector`'s child frame), not
 * silently re-resolve to the main frame internally. Before the fix under
 * test, the probe discarded its `target` parameter and called
 * `resolveFrameTarget(page)` with no selector — which always returns a
 * main-frame target — so an in-iframe wizard's leaf-invalid fields and
 * interactive targets never reached the replan/rephrase prompt's FORM
 * FIELDS section.
 *
 * `probeLeafInvalidContainers`'s own DOM-probe logic is covered in
 * `flow-runner.frame-primitive-helpers.test.ts`; this file only asserts which
 * target the CALLER hands it.
 */

/** Angular-invalid markup with one leaf field and one clickable interactive target next to it. */
const WIZARD_INVALID_HTML =
  '<div class="ng-invalid"><label class="question-title">State</label>' +
  "<app-input></app-input><label>Colorado</label></div>";

function makeEvaluateImpl(bodyHtml: string) {
  return vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("document.body ? document.body.outerHTML")) return bodyHtml;
    if (src.includes("errorTextFor")) {
      return [
        {
          xpath: "/html[1]/body[1]/div[1]",
          label: "State",
          framework: "angular",
          markerClass: "ng-invalid",
          visibleErrorText: null,
          inputTag: "app-input",
        },
      ];
    }
    if (src.includes("questionTitleOf")) {
      return ["[State] label 'Colorado' — xpath=/html[1]/body[1]/div[1]/label[2]"];
    }
    return null;
  });
}

function makeChildTarget(): { target: FrameTarget; evaluate: ReturnType<typeof vi.fn> } {
  const evaluate = makeEvaluateImpl(WIZARD_INVALID_HTML);
  const target: FrameTarget = {
    frame: {} as FrameTarget["frame"],
    frameSelector: "iframe#talemetry_apply_iframe",
    evaluate: evaluate as FrameTarget["evaluate"],
    locator: vi.fn(),
    url: () => Promise.resolve("https://apply.talemetry.com/application/abc-123"),
    title: () => Promise.resolve("Apply"),
  };
  return { target, evaluate };
}

describe("flow-runner/extractLivePageFormEvidence — replan probe frame scoping", () => {
  it("with a declared frameSelector, evaluates against the child frame and surfaces the in-frame required field", async () => {
    const { target: childTarget, evaluate: childEvaluate } = makeChildTarget();
    const pageEvaluate = vi.fn().mockResolvedValue(null);
    const page = { evaluate: pageEvaluate } as unknown as Page;

    const evidence = await extractLivePageFormEvidence(page, childTarget);

    expect(pageEvaluate).not.toHaveBeenCalled();
    expect(childEvaluate).toHaveBeenCalled();
    expect(evidence.invalidFieldList).toContain("State");
    expect(evidence.invalidFieldList).toContain("app-input");
    expect(evidence.interactiveTargetsList).toContain("Colorado");
  });

  it("a frame-less flow produces today's identical main-frame payload from the same markup", async () => {
    const evaluate = makeEvaluateImpl(WIZARD_INVALID_HTML);
    const page = { evaluate } as unknown as Page;

    const evidence = await extractLivePageFormEvidence(page, mainFrameTarget(page));

    expect(evaluate).toHaveBeenCalled();
    expect(evidence.invalidFieldList).toContain("State");
    expect(evidence.invalidFieldList).toContain("app-input");
    expect(evidence.interactiveTargetsList).toContain("Colorado");
  });

  it("the child-frame and main-frame payloads are byte-identical for identical markup — the fix changes WHERE evidence is read, not its shape", async () => {
    const { target: childTarget } = makeChildTarget();
    const childPage = { evaluate: vi.fn().mockResolvedValue(null) } as unknown as Page;
    const childEvidence = await extractLivePageFormEvidence(childPage, childTarget);

    const mainEvaluate = makeEvaluateImpl(WIZARD_INVALID_HTML);
    const mainPage = { evaluate: mainEvaluate } as unknown as Page;
    const mainEvidence = await extractLivePageFormEvidence(mainPage, mainFrameTarget(mainPage));

    expect(childEvidence).toEqual(mainEvidence);
  });
});

/**
 * Regression coverage for `probeStepBeforeAttempts`'s pre-cascade
 * reachability gate: on a cross-origin OOPIF, Stagehand's `observe()` is
 * blind (returns `[]` for both a focused and an unfocused call — see
 * `deep-locator-candidates.ts`'s module docblock for the measured proof),
 * so the probe must fall back to `page.deepLocator()` before declaring a
 * frame-scoped step "absent" and short-circuiting to replan ahead of the
 * healing cascade.
 */
const guardedObserveEmpty = vi.fn().mockResolvedValue([]);

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserveEmpty(...args),
  };
});

const PROBE_FRAME_SELECTOR = "iframe#talemetry_apply_iframe";

const probeTestLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeProbeChildFrameTarget(): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: PROBE_FRAME_SELECTOR,
    evaluate: vi.fn().mockResolvedValue(null),
    locator: vi.fn(),
    url: () => Promise.resolve("https://apply.talemetry.com/application/abc-123"),
    title: () => Promise.resolve("Apply"),
  };
}

describe("flow-runner/probeStepBeforeAttempts — frame-scoped deepLocator fallback", () => {
  it("resolves 'present' via deepLocator when focused and unfocused observe both return zero candidates on a child frame", async () => {
    const frame = new Map();
    registerDeepLocatorHop(frame, `${PROBE_FRAME_SELECTOR} >> *`);
    const page = { deepLocator: makeFakeDeepLocator(frame) } as unknown as Page;

    const result = await probeStepBeforeAttempts({
      stagehand: {} as unknown as Stagehand,
      page,
      step: "Click Manual Application",
      stepIndex: 0,
      logger: probeTestLogger,
      frameTarget: makeProbeChildFrameTarget(),
    });

    expect(result).toBe("present");
  });

  it("negative control: resolves 'absent' when observe AND deepLocator both find nothing (not via a thrown error)", async () => {
    const page = { deepLocator: makeFakeDeepLocator(new Map()) } as unknown as Page;

    const result = await probeStepBeforeAttempts({
      stagehand: {} as unknown as Stagehand,
      page,
      step: "Click Manual Application",
      stepIndex: 0,
      logger: probeTestLogger,
      frameTarget: makeProbeChildFrameTarget(),
    });

    expect(result).toBe("absent");
  });

  it("main-frame target (frame: null) never calls deepLocator, preserving today's behavior byte-for-byte", async () => {
    const deepLocatorSpy = vi.fn();
    const page = { deepLocator: deepLocatorSpy } as unknown as Page;

    const result = await probeStepBeforeAttempts({
      stagehand: {} as unknown as Stagehand,
      page,
      step: "Click Manual Application",
      stepIndex: 0,
      logger: probeTestLogger,
      frameTarget: undefined,
    });

    expect(result).toBe("absent");
    expect(deepLocatorSpy).not.toHaveBeenCalled();
  });
});
