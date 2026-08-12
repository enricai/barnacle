import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeDeepLocatorFrame,
  type FakeDeepLocatorHangingHop,
  makeFakeDeepLocator,
  registerDeepLocatorHangingHop,
  registerDeepLocatorHop,
} from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Offline, CI-safe end-to-end regression for the top-window site/the embedded apply wizard
 * cross-origin iframe bug: `careers.example.org` embeds its entire
 * application wizard inside a same-origin-looking but cross-origin
 * `<iframe id="apply_frame" src="https://apply.example.com/...">`
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

const TOP_ORIGIN = "https://careers.example.org";
const CHILD_ORIGIN = "https://apply.example.com";
const IFRAME_SELECTOR = "iframe#apply_frame";
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
 * resolved child frame (selector carrying the `iframe#apply_frame >> `
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
 * candidate (matches real Stagehand act-string frequently phantom-failing on
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
 * `act` call must actually succeed (matching Stagehand having resolved a
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
 * matching the reported bug at the fixture level. Includes the CDP-session
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
    title: async () => "the top-window site Careers",
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
 * `makeFakeTopPage`, the `#apply_frame` element and the matching
 * `page.frames()` entry BOTH stay absent until `iframeAttached.current` flips
 * true. Models the exact reported timeline — `careers.example.org` mounts
 * the embedded apply wizard iframe only once the "Apply now" step's click runs,
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
    title: async () => "the top-window site Careers",
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
 * matching the click event that mounts the wizard iframe. Step 2 ("Manual
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
        // — the top document stays on careers.example.org throughout, per
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
      // Attempt-1 act-string for any in-frame-only step: matches Stagehand
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
      rephraseModel: null,
      uploadFixture: null,
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
        rephraseModel: null,
        uploadFixture: null,
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
 * `#apply_frame` element nor its matching `page.frames()` entry
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
      rephraseModel: null,
      uploadFixture: null,
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
        rephraseModel: null,
        uploadFixture: null,
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
      title: async () => "the top-window site Careers",
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
      rephraseModel: null,
      uploadFixture: null,
    });

    expect(result.lastStepIndex).toBe(0);
  });
});

/**
 * Fake Stagehand whose `observe()` returns `[]` UNCONDITIONALLY — for a
 * hop-scoped selector, an unscoped call, and a top-frame-only call alike —
 * reproducing the measured A/B/C/D probe against the live the top-window site/the embedded apply wizard
 * OOPIF (`observe(instr, {selector: "#iframe >> *"})` => `[]`;
 * `observe(instr, {selector: "iframe#... >> button"})` => `[]`; unscoped
 * `observe(instr)` => `[]`; identical on Stagehand 3.7.0 and 3.7.1). Unlike
 * `makeFakeStagehand` above (whose observe DOES resolve a hop-scoped
 * selector — the very assumption this fixture exists to falsify), nothing
 * here ever hands the cascade an observe-sourced candidate: the ONLY path to
 * the in-frame button is `page.deepLocator()`. `act` matches the measured
 * unresolved-instruction-string failure (Stagehand's act-string path can't
 * resolve content its own observe can't see either) so attempt 1 always
 * fails, forcing the cascade into attempt 2's observe-act branch — the one
 * that owns the `resolveDeepLocatorCandidates` fallback under test.
 */
function makeFakeStagehandObserveBlind() {
  return {
    act: async () => ({
      success: false,
      message: "no actionable candidate",
      actionDescription: CLICK_STEP,
      actions: [],
    }),
    observe: async () => [],
  } as unknown as import("@browserbasehq/stagehand").Stagehand;
}

/**
 * `makeFakeTopPage`'s top-frame `Page`, plus a `deepLocator()` bound to
 * `deepLocatorFrame` — the shared `deep-locator-fake.ts` harness resolving
 * against an in-memory hop registry, matching `page.deepLocator()`
 * (Stagehand's own deep-iframe resolver, measured to locate AND actuate
 * elements inside the cross-origin OOPIF end-to-end). Wraps the fake
 * delegate's `click()` to also advance `childUrls` — a real deepLocator
 * click on the in-iframe button navigates the iframe, giving the cascade's
 * frame-scoped `urlChanged` verification signal a genuine reason to fire.
 */
function makeFakeTopPageWithDeepLocator(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame
) {
  const base = makeFakeTopPage(topUrl, childUrls);
  const fakeDeepLocator = makeFakeDeepLocator(deepLocatorFrame);
  const wrappedDeepLocator = (selector: string) => {
    const delegate = fakeDeepLocator(selector);
    return {
      ...delegate,
      click: async () => {
        await delegate.click();
        childUrls.current = `${CHILD_ORIGIN}/application/abc-123/basic-info`;
      },
      nth: () => wrappedDeepLocator(selector),
    };
  };
  return {
    ...base,
    deepLocator: wrappedDeepLocator,
  } as unknown as import("@browserbasehq/stagehand").Page;
}

/**
 * The offline analogue of the task's acceptance test: `observe()` blind by
 * every scoping means (the A/B/C/D probe result), `page.deepLocator()` the
 * ONLY surface that can see the in-frame "Manual Application" control —
 * proving `runHealingFlow`'s frame-scoped deepLocator fallback (the
 * `resolveDeepLocatorCandidates`/`clickDeepLocatorCandidate` routing added to
 * the observe-act branch) is what makes the step succeed, not any residual
 * observe capability the `:360` suite's fixture (deliberately) still grants.
 */
describe("flow-runner iframe end-to-end: observe blind to the OOPIF, only deepLocator can see it (offline fixture, no network)", () => {
  it("resolves the in-frame 'Manual Application' button via deepLocator and succeeds even though observe() returns [] for every scoping", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const deepLocatorFrame = new Map();
    const interactiveHop = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    registerDeepLocatorHop(deepLocatorFrame, interactiveHop, "Manual Application");
    // probeStepBeforeAttempts deliberately keeps requesting "*" (a
    // reachability gate, not the candidate set the cascade acts on — see
    // deep-locator-candidates.ts's module docblock), so it needs its own hop
    // registered to report "present" before the cascade runs.
    registerDeepLocatorHop(deepLocatorFrame, `${IFRAME_SELECTOR} >> *`, "Manual Application");
    const stagehand = makeFakeStagehandObserveBlind();
    const page = makeFakeTopPageWithDeepLocator(topUrl, childUrls, deepLocatorFrame);

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [{ instruction: CLICK_STEP, optional: false, upload: false, submitStep: false }],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: IFRAME_SELECTOR,
    });

    expect(result.lastStepIndex).toBe(0);
    expect(childUrls.current).toBe(`${CHILD_ORIGIN}/application/abc-123/basic-info`);
    const hop = deepLocatorFrame.get(interactiveHop);
    expect(hop?.clicks).toBeGreaterThan(0);
  });

  it("negative control: with deepLocator ALSO empty, the step fails — the pass above is attributable to deepLocator, not residual observe behavior", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const deepLocatorFrame = new Map();
    // Deliberately no registerDeepLocatorHop call: deepLocator resolves 0
    // candidates too, matching observe's blindness — nothing can see the
    // in-frame button.
    const stagehand = makeFakeStagehandObserveBlind();
    const page = makeFakeTopPageWithDeepLocator(topUrl, childUrls, deepLocatorFrame);

    // With BOTH observe and deepLocator empty, probeStepBeforeAttempts (the
    // pre-cascade reachability gate) itself reports "absent" and
    // short-circuits before the 5-attempt cascade ever runs — a step
    // genuinely unreachable by any candidate source must fail fast, not
    // burn cascade/replan budget. This is a distinct (and equally valid)
    // failure mode from the cascade exhausting, so the match spans both.
    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [{ instruction: CLICK_STEP, optional: false, upload: false, submitStep: false }],
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        frameSelector: IFRAME_SELECTOR,
      })
    ).rejects.toThrow(/cascade|attempts|verification|candidates/i);

    expect(childUrls.current).toBe(CHILD_SRC);
  });
});

const FIRST_NAME_STEP = "Fill in First Name";
const LAST_NAME_STEP = "Fill in Last Name";
const UPLOAD_STEP = "Upload resume";
const SUBMIT_STEP = "Click the final Submit button";
const THANK_YOU_URL = `${CHILD_ORIGIN}/application/abc-123/thank-you`;
const SUBMITTED_STATE_SELECTOR = "[data-testid=thank-you]";

const FIRST_NAME_CANDIDATE = {
  selector: "xpath=//input[@id='fname']",
  description: "First Name",
  method: "fill",
  arguments: ["Jane"],
};
const LAST_NAME_CANDIDATE = {
  selector: "xpath=//input[@id='lname']",
  description: "Last Name",
  method: "fill",
  arguments: ["Doe"],
};
const SUBMIT_CANDIDATE = {
  selector: "css=button#submit",
  description: "Submit button",
  method: "click",
};

/**
 * In-memory model of the fields the acceptance sequence fills/uploads/submits
 * inside the OOPIF, so the fixture can assert every in-frame effect actually
 * landed (not just that the flow "completed"). Distinct from
 * `FakeDeepLocatorFrame` (the click step's ONLY resolution path) — this
 * backs the fill/upload/submit steps, which per the task's own analysis are
 * already frameTarget-direct and must NOT be routed through deepLocator.
 */
interface AcceptanceSequenceState {
  filledWith: Map<string, string>;
  fileInputCount: number;
  uploadedFileName: string | null;
  submitted: boolean;
}

/**
 * Child `Frame` fake for the full acceptance sequence: extends
 * `makeFakeChildFrame`'s location.href contract with per-selector fill
 * readback (`verifyDomEffect`'s fill branch calls `locator(selector)
 * .first().inputValue()`), a file-input-count probe + `setInputFiles`
 * (`tryUploadPrimitive`/`attachToSurfacedInput`), and a submitted-state DOM
 * marker (the final-step submit-verify gate's `document.querySelector(sel)`
 * probe). `evaluate` still discriminates on expression shape, matching every
 * sibling fixture in this file, so unrelated probes (snapshotPage,
 * countNgInvalidContainers, structured-click, n+16) see harmless defaults.
 *
 * The upload primitive verifies via `waitForUploadNetworkSignal` FIRST,
 * falling back to a DOM-attached-file check only after that call's full
 * `UPLOAD_NETWORK_TIMEOUT_MS` real-time window elapses (see
 * `wireSignalCapture`'s module docblock: the CDP session it listens on is
 * always `page.getSessionForFrame(page.mainFrameId())` — the MAIN frame's
 * session — so a cross-origin OOPIF's own upload POST, fired on the
 * iframe's own separate CDP target, never reaches those listeners
 * regardless of same-origin filtering. The network-signal path is
 * structurally unreachable for a cross-origin OOPIF upload; this fixture
 * exercises the DOM-attached-file fallback that actually carries the OOPIF
 * case in production today — a real gap, not a fixture shortcut, reported
 * rather than routed around). `setInputFiles` marks the DOM-attached state
 * this fallback reads.
 */
function makeAcceptanceChildFrame(childUrls: { current: string }, state: AcceptanceSequenceState) {
  return {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      if (src === "location.href") return childUrls.current;
      if (src === "document.readyState") return "complete";
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return { html: 500, text: "1:apply" };
      }
      if (src.includes('querySelectorAll("[class],[aria-invalid]")')) return 0;
      if (src.includes("querySelectorAll('input[type=file]').length")) {
        return state.fileInputCount;
      }
      // Framework-wrapper change-dispatch (post-setInputFiles): reports
      // whether a file landed, matching the real expr's own files.length>0 check.
      if (src.includes("el.files && el.files.length > 0) { el.dispatchEvent")) {
        return state.uploadedFileName !== null;
      }
      // DOM-attached-file fallback check (the only path that verifies a
      // cross-origin OOPIF upload — see the docblock above).
      if (src.includes("el.files && el.files.length > 0) return el.files.length")) {
        return state.uploadedFileName !== null ? 1 : 0;
      }
      if (src.includes("document.querySelector(sel)")) {
        return state.submitted ? SUBMITTED_STATE_SELECTOR : null;
      }
      return null;
    },
    locator: (selector: string) => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => state.filledWith.get(selector) ?? "",
        setInputFiles: async (file: { name: string }) => {
          state.uploadedFileName = file.name;
        },
      }),
    }),
  };
}

/**
 * Fake two-frame `Page` for the full acceptance sequence: the iframe already
 * exists at flow start (this suite's concern is threading frame scope across
 * consecutive steps, not the mid-flow-attach timeline `describe` above
 * already covers), plus `deepLocator` for the click step. `waitForTimeout`
 * resolves instantly like every sibling fixture's — it backs the upload
 * primitive's real-time `waitForUploadNetworkSignal` poll, which this
 * fixture deliberately lets time out (see `makeAcceptanceChildFrame`'s
 * docblock) so the DOM-attached-file fallback runs.
 */
function makeFakeTopPageForAcceptanceSequence(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame,
  state: AcceptanceSequenceState
) {
  const session = { on: () => {}, off: () => {} };
  const childFrame = makeAcceptanceChildFrame(childUrls, state);
  const fakeDeepLocator = makeFakeDeepLocator(deepLocatorFrame);
  const wrappedDeepLocator = (selector: string) => {
    const delegate = fakeDeepLocator(selector);
    return {
      ...delegate,
      click: async () => {
        await delegate.click();
        childUrls.current = `${CHILD_ORIGIN}/application/abc-123/basic-info`;
      },
      nth: () => wrappedDeepLocator(selector),
    };
  };
  return {
    evaluate: async (expr: unknown) => {
      const iframeSrcMatch = /document\.querySelector\((.+?)\)/.exec(String(expr));
      if (iframeSrcMatch) {
        const selector = JSON.parse(iframeSrcMatch[1] as string) as string;
        return selector === IFRAME_SELECTOR
          ? { matched: true, src: CHILD_SRC }
          : { matched: false, src: null };
      }
      return null;
    },
    url: () => topUrl.current,
    title: async () => "the top-window site Careers",
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
    deepLocator: wrappedDeepLocator,
  } as unknown as import("@browserbasehq/stagehand").Page;
}

/**
 * Fake Stagehand for the full acceptance sequence: `observe()` is blind
 * (returns `[]`) ONLY for the in-frame "Manual Application" click — the
 * exact shape `makeFakeStagehandObserveBlind` reproduces above — forcing
 * that single step through the `deepLocator` fallback under test. Every
 * other frame-scoped step (First/Last Name fill, Submit) gets a normal
 * frame-scoped candidate from `observe()`, per the task's own analysis that
 * only the CLICK path routes through deepLocator — fill/upload/submit are
 * already frameTarget-direct. `act(instruction: string)` (attempt 1) always
 * phantom-fails for every step, matching real Stagehand's act-string path
 * failing on content behind the OOPIF boundary and forcing every step
 * through attempt 2's observe-act path.
 */
function makeFakeStagehandForAcceptanceSequence(
  childUrls: { current: string },
  state: AcceptanceSequenceState
) {
  const hopPrefix = `${IFRAME_SELECTOR} >> `;
  return {
    act: async (input: unknown) => {
      if (typeof input === "object" && input !== null && "selector" in input) {
        const candidate = input as { selector: unknown; method?: unknown };
        if (candidate.selector === FIRST_NAME_CANDIDATE.selector) {
          state.filledWith.set(FIRST_NAME_CANDIDATE.selector, "Jane");
          return {
            success: true,
            message: "filled",
            actionDescription: FIRST_NAME_CANDIDATE.description,
            actions: [FIRST_NAME_CANDIDATE],
          };
        }
        if (candidate.selector === LAST_NAME_CANDIDATE.selector) {
          state.filledWith.set(LAST_NAME_CANDIDATE.selector, "Doe");
          return {
            success: true,
            message: "filled",
            actionDescription: LAST_NAME_CANDIDATE.description,
            actions: [LAST_NAME_CANDIDATE],
          };
        }
        if (candidate.selector === SUBMIT_CANDIDATE.selector) {
          childUrls.current = THANK_YOU_URL;
          state.submitted = true;
          return {
            success: true,
            message: "clicked",
            actionDescription: SUBMIT_CANDIDATE.description,
            actions: [SUBMIT_CANDIDATE],
          };
        }
      }
      // Attempt 1 (act-string, every step): matches Stagehand failing to
      // resolve content behind the OOPIF boundary via its own act-string path.
      return {
        success: false,
        message: "no actionable candidate",
        actionDescription: typeof input === "string" ? input : CLICK_STEP,
        actions: [],
      };
    },
    observe: async (instruction?: unknown, options?: { selector?: string }) => {
      const isFrameScoped = options?.selector?.startsWith(hopPrefix) ?? false;
      if (!isFrameScoped) return TOP_FRAME_CANDIDATES;
      // The one step under test that observe() can NEVER see, by any
      // scoping means — the OOPIF-blindness this whole file exists to
      // reproduce. Every other frame-scoped step resolves normally.
      if (instruction === CLICK_STEP) return [];
      if (instruction === FIRST_NAME_STEP) return [FIRST_NAME_CANDIDATE];
      if (instruction === LAST_NAME_STEP) return [LAST_NAME_CANDIDATE];
      if (instruction === SUBMIT_STEP) return [SUBMIT_CANDIDATE];
      return [];
    },
  } as unknown as import("@browserbasehq/stagehand").Stagehand;
}

/**
 * The task's stated acceptance sequence, offline: one `runHealingFlow` call
 * carrying frame scope across Manual Application (click, deepLocator-only) ->
 * First/Last Name (fill) -> resume upload -> a verified Submit, with
 * `observe()` blind to the OOPIF throughout — proving the frame scope
 * survives across consecutive steps in a single flow run, not just in
 * isolated single-step fixtures (`iframe-e2e.test.ts`'s own single-click
 * suites above) or via helpers driven directly (the upload/fill/submit
 * frame-scoping suites this file's docblock names).
 */
describe("flow-runner iframe end-to-end: full acceptance sequence through the OOPIF (offline fixture, no network)", () => {
  it("carries frame scope across click -> fill -> upload -> submit in one runHealingFlow call, with observe() blind to the OOPIF throughout", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const state: AcceptanceSequenceState = {
      filledWith: new Map(),
      // Pre-rendered <input type=file> (the raw-input path) — the render-wait
      // poll finds it on its first check, so only the network-signal wait
      // (deliberately timed out, see makeAcceptanceChildFrame's docblock)
      // adds real wall-clock time to this test.
      fileInputCount: 1,
      uploadedFileName: null,
      submitted: false,
    };
    const deepLocatorFrame = new Map();
    const interactiveHop = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    registerDeepLocatorHop(deepLocatorFrame, interactiveHop, "Manual Application");
    // probeStepBeforeAttempts deliberately keeps requesting "*" (a
    // reachability gate, not the candidate set the cascade acts on — see
    // deep-locator-candidates.ts's module docblock), so it needs its own hop
    // registered to report "present" before the cascade runs.
    registerDeepLocatorHop(deepLocatorFrame, `${IFRAME_SELECTOR} >> *`, "Manual Application");
    const stagehand = makeFakeStagehandForAcceptanceSequence(childUrls, state);
    const page = makeFakeTopPageForAcceptanceSequence(topUrl, childUrls, deepLocatorFrame, state);

    const steps: HealingFlowStep[] = [
      { instruction: CLICK_STEP, optional: false, upload: false, submitStep: false },
      { instruction: FIRST_NAME_STEP, optional: false, upload: false, submitStep: false },
      { instruction: LAST_NAME_STEP, optional: false, upload: false, submitStep: false },
      { instruction: UPLOAD_STEP, optional: false, upload: true, submitStep: false },
      { instruction: SUBMIT_STEP, optional: false, upload: false, submitStep: true },
    ];

    const result = await runHealingFlow({
      stagehand,
      page,
      steps,
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: {
        buffer: Buffer.from("pdf-bytes"),
        name: "resume.pdf",
        mimeType: "application/pdf",
      },
      frameSelector: IFRAME_SELECTOR,
      submittedStateSelectors: [SUBMITTED_STATE_SELECTOR],
    });

    // The flow reached and completed its last step (the submit).
    expect(result.lastStepIndex).toBe(steps.length - 1);
    expect(result.submitStepSkipped).toBe(false);
    expect(result.submitVerified).toBe(true);

    // Step 1 (Manual Application): resolved ONLY via deepLocator, observe()
    // never saw it — the hop's click count is the sole proof of causation.
    const hop = deepLocatorFrame.get(interactiveHop);
    expect(hop?.clicks).toBeGreaterThan(0);
    expect(childUrls.current).not.toBe(CHILD_SRC);

    // Steps 2-3 (First/Last Name): each in-frame fill actually landed.
    expect(state.filledWith.get(FIRST_NAME_CANDIDATE.selector)).toBe("Jane");
    expect(state.filledWith.get(LAST_NAME_CANDIDATE.selector)).toBe("Doe");

    // Step 4 (Upload resume): the fixture resume was attached in-frame.
    expect(state.uploadedFileName).toBe("resume.pdf");

    // Step 5 (Submit): the in-frame submit control was clicked, the child
    // frame transitioned, and the submitted-state DOM marker is present.
    expect(state.submitted).toBe(true);
    expect(childUrls.current).toBe(THANK_YOU_URL);
  });

  it("negative control: with deepLocator empty, the click step never reaches the in-frame button and the whole sequence fails before fill/upload/submit run", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const state: AcceptanceSequenceState = {
      filledWith: new Map(),
      fileInputCount: 0,
      uploadedFileName: null,
      submitted: false,
    };
    // Deliberately no registerDeepLocatorHop call: deepLocator resolves 0
    // candidates, matching observe's blindness on the click step — nothing
    // can see the in-frame "Manual Application" button, so the sequence
    // must fail at step 0 and never reach fill/upload/submit.
    const deepLocatorFrame = new Map();
    const stagehand = makeFakeStagehandForAcceptanceSequence(childUrls, state);
    const page = makeFakeTopPageForAcceptanceSequence(topUrl, childUrls, deepLocatorFrame, state);

    const steps: HealingFlowStep[] = [
      { instruction: CLICK_STEP, optional: false, upload: false, submitStep: false },
      { instruction: FIRST_NAME_STEP, optional: false, upload: false, submitStep: false },
      { instruction: LAST_NAME_STEP, optional: false, upload: false, submitStep: false },
      { instruction: UPLOAD_STEP, optional: false, upload: true, submitStep: false },
      { instruction: SUBMIT_STEP, optional: false, upload: false, submitStep: true },
    ];

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps,
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: {
          buffer: Buffer.from("pdf-bytes"),
          name: "resume.pdf",
          mimeType: "application/pdf",
        },
        frameSelector: IFRAME_SELECTOR,
        submittedStateSelectors: [SUBMITTED_STATE_SELECTOR],
      })
    ).rejects.toThrow(/cascade|attempts|verification|candidates/i);

    // Attributable to the click step specifically: no fill, no upload, no
    // submit ever ran, and the child frame never left its initial URL.
    expect(state.filledWith.size).toBe(0);
    expect(state.uploadedFileName).toBeNull();
    expect(state.submitted).toBe(false);
    expect(childUrls.current).toBe(CHILD_SRC);
  });
});

/**
 * Fake `Stagehand` for the run-6 composite regression: `act()` (attempt 1's
 * act-string call) matches the reported timeline exactly — the OOPIF does
 * NOT exist yet when `runHealingFlow`'s step-entry `resolveFrameTarget` polls
 * for it (so that poll exhausts and falls back to the main frame, the run 5
 * vs. run 6 divergence), and only attaches as a side effect of THIS call,
 * i.e. after step entry already gave up. `observe()` matches
 * `makeFakeStagehandObserveBlind`/`makeFakeStagehandAttachingOnAct`: every
 * FOCUSED call (an instruction string) is blind, forcing the cascade past
 * attempt 1 and into attempt 2's observe-act branch — the one that owns the
 * `reresolveFrameTargetIfLost`/deepLocator gate under test — while the
 * UNFOCUSED call (no instruction) stays non-empty so `probeStepBeforeAttempts`
 * declares the step "present" via its own unfocused-observe fallback without
 * ever touching `frameTarget.frame` or `deepLocator` itself. Deliberately
 * does NOT touch `childUrls` — the deepLocator gate's own `pre` snapshot is
 * taken while `frameTarget` is still main-frame-bound (before
 * `reresolveFrameTargetIfLost` runs), so if this side effect moved the CHILD
 * frame's URL away from the top frame's, the mere act of re-resolving from
 * main to child mid-attempt would itself look like `urlChanged` even with
 * ZERO deepLocator candidates ever resolved — a false verification signal
 * unrelated to the watchdog fix under test. Leaving `childUrls` at its
 * caller-seeded value (matching `topUrl` — see the `it` block below) keeps
 * `urlChanged` attributable ONLY to a genuine deepLocator click.
 */
function makeFakeStagehandForRun6Regression(iframeAttached: { current: boolean }) {
  return {
    act: async () => {
      iframeAttached.current = true;
      return {
        success: false,
        message: "no actionable candidate",
        actionDescription: CLICK_STEP,
        actions: [],
      };
    },
    observe: async (instructionOrOptions?: unknown) =>
      typeof instructionOrOptions === "string"
        ? []
        : [{ selector: "css=body", description: "page body", method: "click" }],
  } as unknown as import("@browserbasehq/stagehand").Stagehand;
}

/**
 * Composite offline regression for the exact run-6 divergence: run 5 vs.
 * run 6 in the bug report differ only in whether step 3's first attempt won
 * or lost the OOPIF attach race — this scenario reproduces the LOSING case
 * (`makeMidflowFakeTopPage`'s late-attach timeline, reused from the
 * mid-flow-attach suite above) composed with a `deepLocator().count()` that
 * never settles (`registerDeepLocatorHangingHop`, reused from the
 * observe-blind suite above and from `test-001`'s shared harness) once the
 * frame re-resolves before the deepLocator gate
 * (`flow-runner.frame-reresolve.test.ts`'s scenario). Unlike either sibling
 * suite alone, this is the one shape that actually produced the reported
 * ~78-minute hang: a lost attach race feeding a racy OOPIF whose deepLocator
 * calls wedge. `deepLocator().count()` never settling on its own means
 * `top` is never computed in the attempt-2/4 gate, so `clickDeepLocatorCandidate`
 * is never reached — the fixture only needs the plain (unwrapped) fake
 * delegate, not the click-advances-childUrls wrapping `makeFakeTopPageWithDeepLocator`
 * needs for its succeeding siblings.
 */
describe("flow-runner iframe end-to-end: run-6 composite regression — late-attaching OOPIF whose deepLocator call stalls (offline fixture, no network)", () => {
  let hangingHop: FakeDeepLocatorHangingHop | undefined;

  beforeEach(() => {
    // flow-runner.ts's deepLocator call sites don't pass `timeoutOptions`, so
    // they always run against deep-locator-candidates.ts's un-overridable
    // 10s default per-call watchdog, and the step-entry `resolveFrameTarget`
    // poll runs against the real (unmocked) `config.scraper.frameReadyTimeoutMs`
    // default (20s) — waiting either out for real would burn ~50s of
    // wall-clock and risk flaking under CI load, so this suite (like
    // `flow-runner.deep-locator-hang.test.ts`) uses fake timers instead of
    // mocking `@/config` — scoped to just this describe block so the other
    // suites in this file keep exercising the real production timeouts.
    vi.useFakeTimers();
  });

  afterEach(() => {
    hangingHop?.release();
    hangingHop = undefined;
    vi.useRealTimers();
  });

  it("settles runHealingFlow to a definite outcome instead of hanging when the OOPIF attaches only after step-entry frame resolution AND the deepLocator gate stalls", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    // Seeded to match `topUrl`, not `CHILD_SRC` — see
    // `makeFakeStagehandForRun6Regression`'s docblock: a value that already
    // differs from `topUrl` would make the deepLocator gate's mid-attempt
    // main-to-child re-resolution alone look like `urlChanged`, independent
    // of whether any deepLocator candidate ever resolved.
    const childUrls = { current: topUrl.current };
    const iframeAttached = { current: false };
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    // The cascade's attempt-2/4/cascade-exhaust-dump branches resolve
    // candidates at the interactive-scoped hop (bugfix-005), not `"*"`; the
    // probe never reaches deepLocator in this suite (see
    // makeFakeStagehandForRun6Regression's unfocused-observe short-circuit),
    // so only this hop needs the hang gate.
    hangingHop = registerDeepLocatorHangingHop(
      deepLocatorFrame,
      `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`,
      {
        hangOn: "count",
        text: "Manual Application",
      }
    );
    const stagehand = makeFakeStagehandForRun6Regression(iframeAttached);
    const page = {
      ...makeMidflowFakeTopPage(topUrl, childUrls, iframeAttached),
      deepLocator: makeFakeDeepLocator(deepLocatorFrame),
    } as unknown as import("@browserbasehq/stagehand").Page;

    expect(iframeAttached.current).toBe(false);

    // Wrap success/failure into a resolved outcome instead of asserting
    // `.resolves`/`.rejects` up front — the bug report's own minimum
    // milestone is "step 3 never hangs — it either succeeds via deepLocator
    // or fails-fast to the next attempt/replan within the watchdog window",
    // so hard-coding one branch here would over-constrain the fix (see
    // investigation_notes). Both branches are exercised elsewhere in this
    // file (the observe-blind suite proves a healthy deepLocator succeeds;
    // `flow-runner.deep-locator-hang.test.ts` proves a permanently-hung one
    // rejects) — this composite scenario's own job is only to prove
    // `runHealingFlow` SETTLES, inside the 30s testTimeout, once both bugs
    // compose.
    const settledPromise = runHealingFlow({
      stagehand,
      page,
      steps: [{ instruction: CLICK_STEP, optional: false, upload: false, submitStep: false }],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: IFRAME_SELECTOR,
    }).then(
      (result) => ({ outcome: "success" as const, result }),
      (error: unknown) => ({ outcome: "failure" as const, error })
    );

    // Advances past: the step-entry resolveFrameTarget poll exhausting its
    // 20s deadline (the OOPIF isn't attached yet — it only attaches inside
    // attempt 1's act(), AFTER that poll already gave up), then each
    // attempt-2/4/cascade-exhaust-dump deepLocator gate's 10s count()
    // watchdog (the hop's hang is never released within this test, so every
    // gate that reaches it times out the same way). 6 x 10s is a generous
    // superset of the ~50s actually needed; advancing past a promise with no
    // pending timers left is a no-op.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }

    const settled = await settledPromise;

    // Proves the "late attach" half of the composite actually happened —
    // the OOPIF was absent at step entry and only attached mid-cascade, not
    // present from the start (which would just be the observe-blind suite's
    // scenario without the run 5 vs. run 6 divergence this test exists for).
    expect(iframeAttached.current).toBe(true);

    if (settled.outcome === "success") {
      expect(settled.result.lastStepIndex).toBe(0);
    } else {
      expect(String((settled.error as Error).message)).toMatch(
        /failed verification after \d+ attempts/
      );
    }
  });
});
