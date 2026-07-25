import { describe, expect, it } from "vitest";
import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Offline, CI-safe end-to-end regression for the UCHealth/Talemetry
 * cross-origin iframe bug: `careers.uchealth.org` embeds its entire
 * application wizard inside a same-origin-looking but cross-origin
 * `<iframe id="talemetry_apply_iframe" src="https://apply.talemetry.com/...">`
 * rather than navigating the top window to it. Stagehand's `observe()`
 * historically returned only top-frame candidates (69 of them, all
 * nav/share/Apply-now controls — never the in-frame "Manual Application"
 * button), so the self-heal cascade exhausted against content it structurally
 * could not perceive.
 *
 * Unlike `frame-target.test.ts` (unit tests `resolveFrameTarget` in
 * isolation) and `flow-runner.frame-threading.test.ts` (mocks
 * `@/scraper/frame-target` + `@/scraper/stagehand-guard` at the module
 * boundary to prove threading), this file runs the REAL `runHealingFlow`
 * through the REAL `resolveFrameTarget` / `guardedObserve` / `guardedAct` —
 * only Stagehand and Playwright's `Page`/`Frame` are faked. It is the single
 * integration-level composition proof: flow file declaring `frameSelector` →
 * frame resolution → frame-scoped observe → click a control that exists
 * ONLY inside the child frame.
 */

const TOP_ORIGIN = "https://careers.uchealth.org";
const CHILD_ORIGIN = "https://apply.talemetry.com";
const IFRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
const CLICK_STEP = "Click the 'Manual Application' button";

const testLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/**
 * The candidate Stagehand's `observe()` returns ONLY when scoped to the
 * resolved child frame (selector carrying the `iframe#talemetry_apply_iframe >> `
 * hop prefix `buildHopSelector` composes) — never for an unscoped or
 * top-frame-only observe. Its `selector` deliberately does NOT start with
 * `"xpath="`, so `verifyDomEffect`'s click branch short-circuits to `false`
 * (`xpathBody` returns null) and the step's success rests entirely on the
 * `urlChanged` signal a real click on this control would produce.
 */
const MANUAL_APPLICATION_CANDIDATE = {
  selector: "css=button#manual-application",
  description: "Manual Application button",
  method: "click",
};

/**
 * The 69-candidates-all-top-frame bug, reproduced at fixture scale: an
 * unscoped or top-frame-scoped observe surfaces only nav/share/Apply-now
 * controls — never the in-frame button. A caller-supplied `options.selector`
 * that does NOT carry the iframe hop prefix (i.e. every call site except the
 * frame-scoped one) gets this same top-frame-only list.
 */
const TOP_FRAME_CANDIDATES = [
  { selector: "css=nav a.careers-home", description: "Careers home link", method: "click" },
  { selector: "css=button.share-linkedin", description: "Share on LinkedIn", method: "click" },
  { selector: "css=button#apply-now", description: "Apply now button", method: "click" },
];

/**
 * Fake Stagehand whose `observe` discriminates on `options.selector`: only a
 * selector carrying the `IFRAME_SELECTOR >> ` hop prefix (the shape
 * `buildHopSelector`/`frameScopedOptions` compose when a resolved
 * `FrameTarget.frameSelector` is threaded through `guardedObserve`) resolves
 * the in-frame candidate. Every other call — no selector, or a selector
 * missing the hop — gets the top-frame-only list, reproducing the reported
 * "69 candidates, all top-frame" bug. `act` never itself resolves a
 * candidate (mirrors real Stagehand act-string frequently phantom-failing on
 * content it can't see): it always reports `actions: []`, forcing the
 * cascade past attempt 1 into the frame-scoped observe+act path (attempt 2)
 * every real fix depends on.
 */
function makeFakeStagehand() {
  return {
    act: async () => ({
      success: false,
      message: "no actionable candidate",
      actionDescription: CLICK_STEP,
      actions: [],
    }),
    observe: async (_instruction?: unknown, options?: { selector?: string }) => {
      const hopPrefix = `${IFRAME_SELECTOR} >> `;
      if (options?.selector?.startsWith(hopPrefix)) {
        return [MANUAL_APPLICATION_CANDIDATE];
      }
      return TOP_FRAME_CANDIDATES;
    },
  } as unknown as import("@browserbasehq/stagehand").Stagehand;
}

/**
 * `guardedAct(stagehand, target, ...)` is called with the resolved
 * `Action` once `observe` surfaces `MANUAL_APPLICATION_CANDIDATE` — that
 * `act` call must actually succeed (mirroring Stagehand having resolved a
 * concrete selector) and flip `page.url()` so the cascade's `urlChanged`
 * verification signal fires. `act(instruction: string, ...)` (attempt 1,
 * unresolved) stays the phantom-failure stub above.
 */
function makeFakeStagehandWithResolvedAct(urls: { current: string }) {
  const base = makeFakeStagehand();
  return {
    ...base,
    act: async (input: unknown) => {
      const isManualApplicationCandidate =
        typeof input === "object" &&
        input !== null &&
        "selector" in input &&
        (input as { selector: unknown }).selector === MANUAL_APPLICATION_CANDIDATE.selector;
      if (isManualApplicationCandidate) {
        urls.current = `${TOP_ORIGIN}/apply/manual`;
        return {
          success: true,
          message: "clicked",
          actionDescription: MANUAL_APPLICATION_CANDIDATE.description,
          actions: [MANUAL_APPLICATION_CANDIDATE],
        };
      }
      // Any other resolved candidate (the top-frame-only nav/share/Apply-now
      // controls surfaced when frameSelector is omitted) is NOT the target —
      // Stagehand "clicks" it but nothing advances the flow, matching the
      // real bug: the wrong (top-frame) content is all that's visible.
      return {
        success: true,
        message: "clicked",
        actionDescription:
          typeof input === "object" && input !== null && "description" in input
            ? String((input as { description: unknown }).description)
            : CLICK_STEP,
        actions:
          typeof input === "object" && input !== null && "selector" in input
            ? [input as never]
            : [],
      };
    },
  } as unknown as import("@browserbasehq/stagehand").Stagehand;
}

/**
 * Minimal fake `Frame`: reachable ONLY via `frame.evaluate`/`frame.locator`
 * (never `page.evaluate`), matching a real cross-origin OOPIF where
 * `contentDocument` is `null` from the top frame's script perspective. Its
 * `location.href` is the child origin, which is what `resolveFrameTarget`
 * matches the `<iframe>` element's `src` origin against.
 */
function makeFakeChildFrame() {
  return {
    evaluate: async (expr: unknown) => {
      if (expr === "location.href") return CHILD_SRC;
      // verifyDomEffect's click-branch xpath probe never runs for this
      // candidate (selector isn't `xpath=`-prefixed, see MANUAL_APPLICATION_CANDIDATE),
      // but return a harmless default for any other frame-scoped evaluate.
      return null;
    },
    locator: () => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
  };
}

/**
 * Fake two-frame `Page`: the top document's `document.querySelector` resolves
 * the `<iframe>` element's `src` attribute (readable cross-origin — only
 * `contentDocument` is blocked), and `frames()` exposes the child `Frame`.
 * Top-frame `evaluate`/`locator` calls NEVER see the in-frame button — only
 * the nav/share/Apply-now controls a real top-frame DOM would expose,
 * mirroring the reported bug at the fixture level. Includes the CDP-session
 * plumbing `wireSignalCapture` requires (`getSessionForFrame`, `mainFrameId`,
 * `sendCDP`), matching the fake in `flow-runner.frame-threading.test.ts`.
 */
function makeFakeTopPage(urls: { current: string }) {
  const session = { on: () => {}, off: () => {} };
  const childFrame = makeFakeChildFrame();
  return {
    evaluate: async (expr: unknown) => {
      const iframeSrcMatch = /document\.querySelector\((.+?)\)/.exec(String(expr));
      if (iframeSrcMatch) {
        const selector = JSON.parse(iframeSrcMatch[1] as string) as string;
        return selector === IFRAME_SELECTOR ? CHILD_SRC : null;
      }
      // Any other top-frame evaluate (verifyDomEffect's xpath probe,
      // pre-cascade DOM-direct helpers) sees an empty top document — the
      // in-frame button never exists from this side of the boundary.
      return null;
    },
    url: () => urls.current,
    title: async () => "UCHealth Careers",
    locator: () => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
    frames: () => [childFrame],
  } as unknown as import("@browserbasehq/stagehand").Page;
}

describe("flow-runner iframe end-to-end (offline fixture, no network)", () => {
  it("resolves the cross-origin child frame and clicks the in-frame-only 'Manual Application' button when frameSelector is set", async () => {
    const urls = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const stagehand = makeFakeStagehandWithResolvedAct(urls);
    const page = makeFakeTopPage(urls);

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [{ instruction: CLICK_STEP, optional: false, upload: false, submitStep: false }],
      logger: testLogger,
      anthropic: null,
      resumeFixture: null,
      frameSelector: IFRAME_SELECTOR,
    });

    expect(result.lastStepIndex).toBe(0);
    expect(urls.current).toBe(`${TOP_ORIGIN}/apply/manual`);
  });

  it("negative control: the SAME fixture WITHOUT frameSelector cannot find the in-frame button and the step fails", async () => {
    const urls = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const stagehand = makeFakeStagehandWithResolvedAct(urls);
    const page = makeFakeTopPage(urls);

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [{ instruction: CLICK_STEP, optional: false, upload: false, submitStep: false }],
        logger: testLogger,
        anthropic: null,
        resumeFixture: null,
        // frameSelector deliberately omitted: today's (pre-fix) main-frame-only behavior.
      })
    ).rejects.toThrow(/cascade|attempts|verification/i);

    // The URL never changed — the top-frame-only observe/act never resolved
    // the in-frame button, so the fixture actually discriminates instead of
    // passing vacuously.
    expect(urls.current).toBe(`${TOP_ORIGIN}/jobs/123/apply`);
  });
});
