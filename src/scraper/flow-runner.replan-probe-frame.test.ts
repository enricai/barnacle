import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { extractLivePageFormEvidence } from "@/scraper/flow-runner";
import { type FrameTarget, mainFrameTarget } from "@/scraper/frame-target";

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
 * `flow-runner.frame-primitives.test.ts`; this file only asserts which
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
