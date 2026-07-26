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
 * concrete selector) and flip the CHILD frame's `location.href` (a click on
 * an in-iframe control navigates the iframe, not the top window) so the
 * cascade's frame-scoped `urlChanged` verification signal fires.
 * `act(instruction: string, ...)` (attempt 1, unresolved) stays the
 * phantom-failure stub above.
 */
function makeFakeStagehandWithResolvedAct(childUrls: { current: string }) {
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
        childUrls.current = `${CHILD_ORIGIN}/application/abc-123/basic-info`;
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
 * `contentDocument` is `null` from the top frame's script perspective.
 * `location.href` backs onto its OWN mutable `childUrls` ref, starting at
 * `CHILD_SRC` — `resolveFrameTarget` origin-matches this against the
 * `<iframe>` element's `src`, so it must stay on the child origin, and a
 * click on an in-iframe control navigates the iframe, not the top window,
 * so it must be independent of the top page's URL. Required now that
 * snapshotPage/countNgInvalidContainers read `frameTarget.url()` (which
 * evaluates `location.href` against this frame) instead of `page.url()`
 * for an in-iframe step (the fix under test): a static href here would
 * make `pre.url === post.url` always, so the cascade's `urlChanged`
 * verification signal could never fire and the step would spuriously
 * exhaust its attempts.
 */
function makeFakeChildFrame(childUrls: { current: string }) {
  return {
    evaluate: async (expr: unknown) => {
      if (expr === "location.href") return childUrls.current;
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
 * `topUrl` is a SEPARATE mutable ref from the child frame's — the top
 * window never navigates when only the in-iframe control is clicked.
 */
function makeFakeTopPage(topUrl: { current: string }, childUrls: { current: string }) {
  const session = { on: () => {}, off: () => {} };
  const childFrame = makeFakeChildFrame(childUrls);
  return {
    evaluate: async (expr: unknown) => {
      const iframeSrcMatch = /document\.querySelector\((.+?)\)/.exec(String(expr));
      if (iframeSrcMatch) {
        const selector = JSON.parse(iframeSrcMatch[1] as string) as string;
        return selector === IFRAME_SELECTOR
          ? { matched: true, src: CHILD_SRC }
          : { matched: false, src: null };
      }
      // Any other top-frame evaluate (verifyDomEffect's xpath probe,
      // pre-cascade DOM-direct helpers) sees an empty top document — the
      // in-frame button never exists from this side of the boundary.
      return null;
    },
    url: () => topUrl.current,
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

/**
 * Mutable-state fake `Page` for the mid-flow-attach scenario: unlike
 * `makeFakeTopPage`, the `#talemetry_apply_iframe` element and the matching
 * `page.frames()` entry BOTH stay absent until `iframeAttached.current` flips
 * true. Models the exact reported timeline — `careers.uchealth.org` mounts
 * the Talemetry wizard iframe only once the "Apply now" step's click runs,
 * so `resolveFrameTarget` has nothing to resolve for any step before that,
 * and must resolve into the child frame for every step after it (bugfix-001's
 * bounded per-poll retry, bugfix-002's per-step re-resolution, bugfix-003's
 * CLI-side readiness gate, and bugfix-004's frame-scoped primitives compose to
 * make this possible at all).
 */
function makeMidflowFakeTopPage(
  topUrl: { current: string },
  childUrls: { current: string },
  iframeAttached: { current: boolean }
) {
  const session = { on: () => {}, off: () => {} };
  const childFrame = makeFakeChildFrame(childUrls);
  return {
    evaluate: async (expr: unknown) => {
      const iframeSrcMatch = /document\.querySelector\((.+?)\)/.exec(String(expr));
      if (iframeSrcMatch) {
        if (!iframeAttached.current) return { matched: false, src: null };
        const selector = JSON.parse(iframeSrcMatch[1] as string) as string;
        return selector === IFRAME_SELECTOR
          ? { matched: true, src: CHILD_SRC }
          : { matched: false, src: null };
      }
      return null;
    },
    url: () => topUrl.current,
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
    frames: () => (iframeAttached.current ? [childFrame] : []),
  } as unknown as import("@browserbasehq/stagehand").Page;
}

const APPLY_NOW_STEP = "Click the 'Apply now' button";
const APPLY_NOW_CANDIDATE = {
  selector: "css=button#apply-now",
  description: "Apply now button",
  method: "click",
};

/**
 * The exact 1.6.8 repro signature ("focused probe found 0 candidates but
 * unfocused observe found 65 candidates"), reproduced at fixture scale: an
 * unscoped/top-frame observe surfaces 65 nav/share/Apply-now-adjacent
 * candidates and never the in-frame "Manual Application" button.
 */
const SIXTY_FIVE_TOP_FRAME_CANDIDATES = Array.from({ length: 65 }, (_, index) => ({
  selector: `css=.top-frame-control-${index}`,
  description: `Top-frame-only control ${index}`,
  method: "click",
}));

/**
 * Fake Stagehand for the mid-flow timeline: step 1 ("Apply now") resolves
 * directly on attempt 1 against the TOP frame (no hop prefix) and, as a side
 * effect of that click, flips `iframeAttached` true and seeds `childUrls` —
 * mirroring the click event that mounts the wizard iframe. Step 2 ("Manual
 * Application") discriminates on `options.selector`'s hop prefix exactly like
 * `makeFakeStagehand` above: frame-scoped observe finds the real candidate,
 * unscoped/top-frame observe gets the 65-candidate wrong-document list, and
 * `act` never itself resolves a candidate for either (forcing the cascade
 * into the frame-scoped attempt-2 observe+act path).
 */
function makeFakeStagehandForMidflowAttach(
  topUrl: { current: string },
  childUrls: { current: string },
  iframeAttached: { current: boolean }
) {
  const hopPrefix = `${IFRAME_SELECTOR} >> `;
  return {
    act: async (input: unknown) => {
      if (input === APPLY_NOW_STEP) {
        iframeAttached.current = true;
        childUrls.current = CHILD_SRC;
        // Same-origin path change (never a cross-origin top-window navigation
        // — the top document stays on careers.uchealth.org throughout, per
        // the reported timeline) is what flips classifyPhantomClick's
        // urlChanged signal: a real "Apply now" click that mounts the wizard
        // also updates the top page's own URL/history state.
        topUrl.current = `${TOP_ORIGIN}/jobs/123/apply?applied=1`;
        return {
          success: true,
          message: "clicked",
          actionDescription: APPLY_NOW_STEP,
          actions: [APPLY_NOW_CANDIDATE],
        };
      }
      const isManualApplicationCandidate =
        typeof input === "object" &&
        input !== null &&
        "selector" in input &&
        (input as { selector: unknown }).selector === MANUAL_APPLICATION_CANDIDATE.selector;
      if (isManualApplicationCandidate) {
        childUrls.current = `${CHILD_ORIGIN}/application/abc-123/basic-info`;
        return {
          success: true,
          message: "clicked",
          actionDescription: MANUAL_APPLICATION_CANDIDATE.description,
          actions: [MANUAL_APPLICATION_CANDIDATE],
        };
      }
      // Attempt-1 act-string for any in-frame-only step: mirrors Stagehand
      // failing to resolve content it structurally cannot see pre-fix.
      return {
        success: false,
        message: "no actionable candidate",
        actionDescription: String(input),
        actions: [],
      };
    },
    observe: async (instruction?: unknown, options?: { selector?: string }) => {
      const isFrameScoped = options?.selector?.startsWith(hopPrefix) ?? false;
      if (!isFrameScoped) return SIXTY_FIVE_TOP_FRAME_CANDIDATES;
      if (instruction === CLICK_STEP) return [MANUAL_APPLICATION_CANDIDATE];
      return [];
    },
  } as unknown as import("@browserbasehq/stagehand").Stagehand;
}

describe("flow-runner iframe end-to-end (offline fixture, no network)", () => {
  it("resolves the cross-origin child frame and clicks the in-frame-only 'Manual Application' button when frameSelector is set", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const stagehand = makeFakeStagehandWithResolvedAct(childUrls);
    const page = makeFakeTopPage(topUrl, childUrls);

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
    expect(childUrls.current).toBe(`${CHILD_ORIGIN}/application/abc-123/basic-info`);
  });

  it("negative control: the SAME fixture WITHOUT frameSelector cannot find the in-frame button and the step fails", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const stagehand = makeFakeStagehandWithResolvedAct(childUrls);
    const page = makeFakeTopPage(topUrl, childUrls);

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

    // The child frame's URL never changed — the top-frame-only observe/act
    // never resolved the in-frame button, so the fixture actually
    // discriminates instead of passing vacuously.
    expect(childUrls.current).toBe(CHILD_SRC);
  });
});

/**
 * The reported gap the two tests above cannot exercise: `flow-runner
 * .frame-threading.test.ts`'s and this file's other fixtures all assume the
 * `<iframe>` exists at flow start, which is precisely why 1.6.8 shipped
 * believing frame-scoped steps worked in general. Here neither the
 * `#talemetry_apply_iframe` element nor its matching `page.frames()` entry
 * exists until step 1's ("Apply now") act runs — the flow must still resolve
 * a LATER step into the frame that click creates.
 */
describe("flow-runner iframe end-to-end: mid-flow iframe attachment (offline fixture, no network)", () => {
  it("step 1 (Apply now) succeeds against the top frame before the iframe exists, then step 2 (Manual Application) resolves into and stays scoped to the child frame it creates", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: "" };
    const iframeAttached = { current: false };
    const stagehand = makeFakeStagehandForMidflowAttach(topUrl, childUrls, iframeAttached);
    const page = makeMidflowFakeTopPage(topUrl, childUrls, iframeAttached);

    expect(iframeAttached.current).toBe(false);

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [
        { instruction: APPLY_NOW_STEP, optional: false, upload: false, submitStep: false },
        { instruction: CLICK_STEP, optional: false, upload: false, submitStep: false },
      ],
      logger: testLogger,
      anthropic: null,
      resumeFixture: null,
      frameSelector: IFRAME_SELECTOR,
    });

    // Step 1 ran and succeeded entirely against the top frame — no iframe
    // existed yet for resolveFrameTarget to find at that point.
    expect(iframeAttached.current).toBe(true);
    // Step 2 resolved into the child frame the click created and clicked the
    // in-frame-only button there (not the 65-candidate top-frame observe).
    expect(result.lastStepIndex).toBe(1);
    expect(childUrls.current).toBe(`${CHILD_ORIGIN}/application/abc-123/basic-info`);
  });

  it("negative control: without frameSelector, the same mid-flow-attach timeline still cannot reach the in-frame step even though the iframe attaches", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: "" };
    const iframeAttached = { current: false };
    const stagehand = makeFakeStagehandForMidflowAttach(topUrl, childUrls, iframeAttached);
    const page = makeMidflowFakeTopPage(topUrl, childUrls, iframeAttached);

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [
          { instruction: APPLY_NOW_STEP, optional: false, upload: false, submitStep: false },
          { instruction: CLICK_STEP, optional: false, upload: false, submitStep: false },
        ],
        logger: testLogger,
        anthropic: null,
        resumeFixture: null,
        // frameSelector deliberately omitted: today's (pre-fix) main-frame-only
        // behavior — step 2 never scopes into the frame step 1's click
        // created, so the cascade exhausts against the 65 top-frame-only
        // candidates instead.
      })
    ).rejects.toThrow(/cascade|attempts|verification/i);

    // The iframe still attaches (step 1's click runs on the top frame either
    // way) but the child frame's URL never advances past its initial
    // creation — proving the failure is "never entered the frame", not
    // "the iframe never appeared".
    expect(iframeAttached.current).toBe(true);
    expect(childUrls.current).toBe(CHILD_SRC);
  });

  it("a no-frameSelector flow is unaffected by the mid-flow-attach machinery (plain top-frame-only flow still works)", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const stagehand = {
      act: async (input: unknown) => {
        topUrl.current = `${TOP_ORIGIN}/jobs/123/apply?applied=1`;
        return {
          success: true,
          message: "clicked",
          actionDescription: String(input),
          actions: [APPLY_NOW_CANDIDATE],
        };
      },
      observe: async () => [APPLY_NOW_CANDIDATE],
    } as unknown as import("@browserbasehq/stagehand").Stagehand;
    const session = { on: () => {}, off: () => {} };
    const page = {
      evaluate: async () => null,
      url: () => topUrl.current,
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
      frames: () => [],
    } as unknown as import("@browserbasehq/stagehand").Page;

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [{ instruction: APPLY_NOW_STEP, optional: false, upload: false, submitStep: false }],
      logger: testLogger,
      anthropic: null,
      resumeFixture: null,
    });

    expect(result.lastStepIndex).toBe(0);
  });
});
