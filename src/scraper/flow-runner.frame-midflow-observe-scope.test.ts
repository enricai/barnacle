import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it } from "vitest";

import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins the composed behaviour of bugfix-001 (bounded per-poll frame
 * resolution + per-step re-resolution) and bugfix-003 (frame-scoped
 * pre-cascade/attempt-1 probes) together at the exact seam neither
 * `flow-runner.frame-midflow-runhealingflow.test.ts` (asserts WHICH
 * `FrameTarget` each step resolves, `guardedObserve`/`guardedAct` mocked at
 * the module boundary) nor `flow-runner.iframe-e2e.test.ts`'s mid-flow suite
 * (asserts end-to-end step success against a fixed candidate list) covers:
 * the actual `selector` string `guardedObserve` hands Stagehand for the
 * SECOND step, built by the real (unmocked) `frameScopedOptions`/
 * `buildHopSelector` from the `FrameTarget` the real (unmocked)
 * `resolveFrameTarget` produced. Only `@browserbasehq/stagehand`'s `Page`/
 * `Stagehand` are faked — `@/scraper/frame-target` and
 * `@/scraper/stagehand-guard` run for real, so a regression in either the
 * resolution polling or the hop-selector composition surfaces here even if
 * the two are individually unit-tested elsewhere.
 *
 * The fake page's `#talemetry_apply_iframe` element and its matching
 * `frames()` entry BOTH start absent (per the reported UCHealth timeline)
 * and are populated only once step 1's `guardedAct` (driven through the fake
 * Stagehand's `act`) resolves — modelling the "Apply now" click mounting the
 * wizard iframe mid-flow rather than it being present at flow start.
 */

const FRAME_SELECTOR = "#talemetry_apply_iframe";
const HOP_PREFIX = `${FRAME_SELECTOR} >> `;
const CHILD_ORIGIN_URL = "https://apply.talemetry.com/application/abc-123";
const APPLY_NOW_STEP = "Click the 'Apply now' button";
const MANUAL_APPLICATION_STEP = "Click the 'Manual Application' button";

const MANUAL_APPLICATION_CANDIDATE = {
  selector: "css=button#manual-application",
  description: "Manual Application button",
  method: "click",
};

const APPLY_NOW_CANDIDATE = {
  selector: "css=button#apply-now",
  description: "Apply now button",
  method: "click",
};

const testLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/**
 * Fake cross-origin `Frame`: `location.href` answers the mutable
 * `getChildUrl` ref so the cascade's `urlChanged` verification signal can
 * fire once step 2's act navigates it, independent of the top document.
 */
function makeFakeChildFrame(getChildUrl: () => string) {
  return {
    evaluate: async (expr: unknown) => {
      if (expr === "location.href") return getChildUrl();
      if (expr === "document.readyState") return "complete";
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
 * Mutable fake `Page`: the `<iframe>` element (read via
 * `document.querySelector`) and the matching `frames()` entry both stay
 * absent until `attach()` runs — modelling the mid-flow mount. Includes the
 * CDP-session plumbing `wireSignalCapture` requires.
 */
function makeMutableFakePage(
  getTopUrl: () => string,
  getChildUrl: () => string
): { page: Page; attach: () => void } {
  let attached = false;
  const childFrame = makeFakeChildFrame(getChildUrl);
  const session = { on: () => {}, off: () => {} };

  const page = {
    url: getTopUrl,
    title: async () => "UCHealth Careers",
    evaluate: async (expr: unknown) => {
      const match = /document\.querySelector\((.+?)\)/.exec(String(expr));
      const selector = match?.[1] ? (JSON.parse(match[1]) as string) : null;
      if (selector !== FRAME_SELECTOR || !attached) return { matched: false, src: null };
      return { matched: true, src: CHILD_ORIGIN_URL };
    },
    locator: () => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async () => {},
    frames: () => (attached ? [childFrame] : []),
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;

  return {
    page,
    attach: () => {
      attached = true;
    },
  };
}

/**
 * Fake Stagehand: step 1's pre-cascade probe (`probeStepBeforeAttempts`,
 * unscoped — no iframe has attached yet) must see a top-frame candidate so
 * the step isn't declared "absent" before `act` ever runs; step 1's
 * `act(APPLY_NOW_STEP)` then succeeds on the first attempt and, as a side
 * effect, attaches the iframe. Step 2's `act` never itself resolves a
 * candidate (mirrors real Stagehand act-string phantom-failing on content it
 * can't yet see pre-resolution), forcing the cascade into attempt 2's
 * `observe` — the call under test. `observe` records every
 * `options.selector` it was called with (skipping step 1's own pre-cascade
 * probe call, which the assertions below are not concerned with) so the
 * test can assert the exact hop-scoped string for step 2, and returns the
 * in-frame candidate ONLY when that selector carries the
 * `#talemetry_apply_iframe >> ` hop prefix; any other call (unscoped, or
 * scoped to the wrong frame) gets an empty list, reproducing the "observe
 * returned no candidates" pre-fix signature.
 */
function makeFakeStagehand(
  attach: () => void,
  setTopUrl: (url: string) => void,
  setChildUrl: (url: string) => void,
  observeSelectors: string[]
): Stagehand {
  return {
    act: async (input: unknown) => {
      if (input === APPLY_NOW_STEP) {
        attach();
        // A real "Apply now" click both mounts the wizard iframe AND
        // advances the top document (a same-origin path/query change, e.g.
        // `?applied=1`) — the `urlChanged` signal `classifyPhantomClick`
        // needs to verify step 1 as a real (non-phantom) click rather than
        // exhausting the cascade on a flat, unchanging top-frame snapshot.
        setTopUrl("https://careers.uchealth.org/jobs/123/apply?applied=1");
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
        setChildUrl(`${CHILD_ORIGIN_URL}/basic-info`);
        return {
          success: true,
          message: "clicked",
          actionDescription: MANUAL_APPLICATION_CANDIDATE.description,
          actions: [MANUAL_APPLICATION_CANDIDATE],
        };
      }
      return {
        success: false,
        message: "no actionable candidate",
        actionDescription: String(input),
        actions: [],
      };
    },
    observe: async (instructionOrOptions?: unknown, maybeOptions?: { selector?: string }) => {
      // Step 1's own pre-cascade probe (main frame, no iframe attached yet)
      // — reproduces a real top-frame reachability check, not the seam this
      // suite pins, so it is deliberately excluded from `observeSelectors`.
      if (instructionOrOptions === APPLY_NOW_STEP) return [APPLY_NOW_CANDIDATE];
      // `guardedObserve` calls `stagehand.observe(scopedOptions)` (ONE arg)
      // for its unfocused/no-instruction probe, and
      // `stagehand.observe(instruction, scopedOptions)` (TWO args) otherwise
      // — mirror both Stagehand overloads so `options.selector` is read from
      // whichever position actually carries it.
      const options =
        typeof instructionOrOptions === "string" || instructionOrOptions === undefined
          ? maybeOptions
          : (instructionOrOptions as { selector?: string } | undefined);
      observeSelectors.push(options?.selector ?? "");
      if (options?.selector?.startsWith(HOP_PREFIX)) {
        return [MANUAL_APPLICATION_CANDIDATE];
      }
      return [];
    },
  } as unknown as Stagehand;
}

describe("flow-runner mid-flow iframe: guardedObserve's actual hop-scoped selector (real resolveFrameTarget + guardedObserve, only Stagehand faked)", () => {
  it("step 1 acts against the main frame (iframe not yet attached), then step 2's guardedObserve is called with a selector carrying the '#talemetry_apply_iframe >> ' hop and returns the in-frame candidate", async () => {
    const topUrls = { current: "https://careers.uchealth.org/jobs/123" };
    const childUrls = { current: CHILD_ORIGIN_URL };
    const { page, attach } = makeMutableFakePage(
      () => topUrls.current,
      () => childUrls.current
    );
    const observeSelectors: string[] = [];
    const stagehand = makeFakeStagehand(
      attach,
      (url) => {
        topUrls.current = url;
      },
      (url) => {
        childUrls.current = url;
      },
      observeSelectors
    );

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [
        { instruction: APPLY_NOW_STEP, optional: false, upload: false, submitStep: false },
        { instruction: MANUAL_APPLICATION_STEP, optional: false, upload: false, submitStep: false },
      ],
      logger: testLogger,
      anthropic: null,
      uploadFixture: null,
      frameSelector: FRAME_SELECTOR,
    });

    // Step 1 ran and succeeded entirely against the top frame — attempt 1's
    // act-string resolved directly (`APPLY_NOW_STEP`'s own observe call is
    // deliberately excluded from `observeSelectors` above), so every
    // recorded call belongs to step 2: its pre-cascade reachability probe,
    // then attempt 2's observe+act fallback once attempt 1's act-string
    // phantom-fails on content it can't yet see pre-resolution.
    expect(observeSelectors).toHaveLength(2);

    // BOTH of step 2's observe calls carry the `#talemetry_apply_iframe >> `
    // hop prefix — proving `resolveFrameTarget` re-resolved per step
    // (bugfix-001) and the hop selector was composed from that fresh
    // resolution (bugfix-003) for every observe call against the step, not a
    // stale/undefined frame target captured before the iframe existed.
    for (const selector of observeSelectors) {
      expect(selector).toBe(`${HOP_PREFIX}*`);
    }

    // Step 2 reports success: the frame-scoped observe found the in-frame
    // candidate and the subsequent act navigated the child frame.
    expect(result.lastStepIndex).toBe(1);
    expect(childUrls.current).toBe(`${CHILD_ORIGIN_URL}/basic-info`);
  });

  it("fails against the pre-fix behaviour: without frameSelector, guardedObserve's selector never carries the hop and step 2 finds 0 candidates", async () => {
    const topUrls = { current: "https://careers.uchealth.org/jobs/123" };
    const childUrls = { current: CHILD_ORIGIN_URL };
    const { page, attach } = makeMutableFakePage(
      () => topUrls.current,
      () => childUrls.current
    );
    const observeSelectors: string[] = [];
    const stagehand = makeFakeStagehand(
      attach,
      (url) => {
        topUrls.current = url;
      },
      (url) => {
        childUrls.current = url;
      },
      observeSelectors
    );

    // Without `frameSelector`, `resolveFrameTarget` degrades to the
    // main-frame target for every step, so `guardedObserve`'s
    // `frameScopedOptions` never has a `frameTarget.frameSelector` to
    // compose a hop from. Step 2's pre-cascade probe (unscoped, same as
    // production's un-fixed behavior) sees the in-frame button nowhere on
    // the top document, so the step is declared "absent" and fails before
    // the observe-act cascade even runs — the exact top-frame-only
    // regression this suite pins against.
    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: [
          { instruction: APPLY_NOW_STEP, optional: false, upload: false, submitStep: false },
          {
            instruction: MANUAL_APPLICATION_STEP,
            optional: false,
            upload: false,
            submitStep: false,
          },
        ],
        logger: testLogger,
        anthropic: null,
        uploadFixture: null,
        // frameSelector deliberately omitted: reproduces the pre-fix
        // top-frame-only behavior even though the iframe attaches.
      })
    ).rejects.toThrow(/probe found no candidates/);

    // Step 2's pre-cascade probe made both its focused and unfocused observe
    // calls (the fallback `probeStepBeforeAttempts` runs before declaring
    // "absent") — neither carries the iframe hop, since no `frameSelector`
    // was declared for `resolveFrameTarget` to scope against.
    expect(observeSelectors.length).toBeGreaterThan(0);
    for (const selector of observeSelectors) {
      expect(selector).not.toMatch(/talemetry_apply_iframe/);
    }
    expect(childUrls.current).toBe(CHILD_ORIGIN_URL);
  });
});
