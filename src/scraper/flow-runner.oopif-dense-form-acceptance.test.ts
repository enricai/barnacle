import { beforeEach, describe, expect, it, vi } from "vitest";

// `deep-locator-candidates.ts` (and `frame-target.ts`) log via their own
// module-scoped `getLogger({name})` instance, NOT via `runHealingFlow`'s
// `logger` dependency — so the "enumeration ... aborted" / "dropped N
// unrendered candidate(s)" warnings this test pins can only be observed by
// intercepting `@/lib/logging` itself, the same seam
// `deep-locator-candidates.enumeration-throughput.test.ts` already uses.
const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({
  getLogger: () => loggerStub,
  getScriptLogger: () => loggerStub,
}));

import {
  type FakeDeepLocatorElementSpec,
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  makeFakeFrameScan,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Offline acceptance regression for the uchealth-7 bug report's own
 * acceptance test, run end to end through the REAL `runHealingFlow` /
 * `resolveFrameTarget` / `guardedObserve` / `resolveDeepLocatorCandidates`
 * stack (only Stagehand and Playwright's `Page`/`Frame` are faked) — the
 * same "acceptance-grade" composition `flow-runner.iframe-e2e.test.ts`'s
 * "full acceptance sequence" block and `flow-runner.oopif-candidate-ranking.test.ts`
 * already establish. Kept in its own file (not appended to either of those)
 * so a 371-element fixture doesn't bloat `flow-runner.iframe-e2e.test.ts`
 * and so a failure here names the run-7 regression directly.
 *
 * Reproduces the measured live shape: `#talemetry_apply_iframe >> *` matches
 * 371 elements — almost all structural filler, plus a handful of interactive
 * controls, two of which (decoys) have no layout box (a responsive wizard's
 * hidden breakpoint variant) — with "Manual Application" LAST in DOM order.
 * DOM-order-last is deliberate: it is what makes a passing run attributable
 * to the ranked cascade rather than DOM-order luck (same falsifier the
 * candidate-ranking suite already uses).
 */

const TOP_ORIGIN = "https://careers.uchealth.org";
const CHILD_ORIGIN = "https://apply.talemetry.com";
const IFRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> *`;
const THANK_YOU_URL = `${CHILD_ORIGIN}/application/abc-123/thank-you`;
const SUBMITTED_STATE_SELECTOR = "[data-testid=thank-you]";

/** Verbatim step instruction from the bug report's flow, naming the target and negating every decoy in one "Do NOT click" clause. */
const MANUAL_APPLICATION_STEP =
  "In the application widget, click the 'Manual Application' button to skip the resume-upload flow entirely. Do NOT click 'Upload a Resume/CV', 'Use LinkedIn Profile', 'Upload From Dropbox', or 'Upload From OneDrive'.";
const FIRST_NAME_STEP = "Fill in First Name";
const LAST_NAME_STEP = "Fill in Last Name";
const UPLOAD_STEP = "Upload resume";
const SUBMIT_STEP = "Click the final Submit button";

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

/** Unscoped/top-frame observe result — never the right candidate for any frame-scoped step, matching every sibling fixture's "wrong list if scoping is lost" shape. */
const TOP_FRAME_CANDIDATES = [
  { selector: "css=nav a.careers-home", description: "Careers home link", method: "click" },
  { selector: "css=button.share-linkedin", description: "Share on LinkedIn", method: "click" },
  { selector: "css=button#apply-now", description: "Apply now button", method: "click" },
];

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/**
 * The four verbatim negated decoys from the bug report's flow instruction.
 * Two are rendered and two are layout-less duplicates — a responsive
 * wizard's hidden breakpoint variant — reproducing the run-7 "some
 * candidates have no layout box" condition. Visibility never changes a
 * decoy's ranking (negated phrases always score below the real target,
 * rendered or not); what it proves is that the batched scan drops them
 * before the cascade ever considers clicking one.
 */
const DECOYS: FakeDeepLocatorElementSpec[] = [
  { text: "Upload a Resume/CV", visible: true },
  { text: "Use LinkedIn Profile", visible: false },
  { text: "Upload From Dropbox", visible: true },
  { text: "Upload From OneDrive", visible: false },
];

/** Filler-block sizes (structural, empty-text, rendered nodes) that sum to 366 — with the 4 decoys and the real target, 371 total, matching the live-measured `"*"` match count. */
const FILLER_BLOCK_SIZES = [100, 100, 100, 66];

/**
 * Builds the 371-element (370 without the target) DOM-order array a `"*"`
 * hop over the dense Talemetry wizard resolves to: filler blocks with the
 * four decoys interspersed between them, and — when `includeTarget` — the
 * real "Manual Application" button LAST.
 */
function buildDenseHopOrder(includeTarget: boolean): Array<string | FakeDeepLocatorElementSpec> {
  const order: Array<string | FakeDeepLocatorElementSpec> = [];
  for (const [index, size] of FILLER_BLOCK_SIZES.entries()) {
    order.push(...Array.from({ length: size }, () => ""));
    const decoy = DECOYS[index];
    if (decoy) order.push(decoy);
  }
  if (includeTarget) order.push("Manual Application");
  return order;
}

/** In-memory model of the fields the acceptance sequence fills/uploads/submits inside the OOPIF, mirroring `flow-runner.iframe-e2e.test.ts`'s `AcceptanceSequenceState`. */
interface AcceptanceSequenceState {
  filledWith: Map<string, string>;
  fileInputCount: number;
  uploadedFileName: string | null;
  submitted: boolean;
}

/**
 * Child `Frame` fake: `location.href`/`document.readyState`/fill-readback/
 * upload/submitted-state probes mirror `flow-runner.iframe-e2e.test.ts`'s
 * `makeAcceptanceChildFrame` exactly, plus one addition — an `evaluate` call
 * whose expression contains `isVisible` (the batched
 * `buildScanFrameCandidatesExpr` marker, `deep-locator-scan.ts`) resolves
 * via `makeFakeFrameScan`, so `resolveDeepLocatorCandidates`'s batched-scan
 * fast path (bugfix-002, already shipped) actually runs against this
 * fixture's 371-element hop instead of falling back to the legacy loop.
 */
function makeDenseChildFrame(
  childUrls: { current: string },
  state: AcceptanceSequenceState,
  deepLocatorFrame: FakeDeepLocatorFrame
) {
  const scan = makeFakeFrameScan(deepLocatorFrame, HOP_SELECTOR);
  return {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      if (src === "location.href") return childUrls.current;
      if (src === "document.readyState") return "complete";
      if (src.includes("isVisible")) return scan();
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return { html: 500, text: "1:apply" };
      }
      if (src.includes('querySelectorAll("[class],[aria-invalid]")')) return 0;
      if (src.includes("querySelectorAll('input[type=file]').length")) {
        return state.fileInputCount;
      }
      if (src.includes("el.files && el.files.length > 0) { el.dispatchEvent")) {
        return state.uploadedFileName !== null;
      }
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
 * Fake two-frame `Page`. `deepLocator(...).nth(index).click()` only
 * navigates the child frame to the basic-info page when `index` is
 * `targetIndex` (the real button's position) — every other index (a decoy,
 * a layout-less duplicate, or filler) either throws
 * `NODE_NOT_ACTIONABLE_MESSAGE` (unrendered) or resolves as a no-op click
 * with zero downstream effect. That per-index discrimination is what makes
 * a passing "urlChanged" verification signal attributable to clicking the
 * CORRECT element, not just attributable to "some click happened" (the gap
 * the single-element `registerDeepLocatorHop` fixtures elsewhere in this
 * suite family don't need to close, since they only ever register one
 * candidate). `targetIndex: null` (the negative control) means no index
 * ever navigates.
 */
function makeDenseTopPage(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame,
  state: AcceptanceSequenceState,
  targetIndex: number | null
) {
  const session = { on: () => {}, off: () => {} };
  const childFrame = makeDenseChildFrame(childUrls, state, deepLocatorFrame);
  const fakeDeepLocator = makeFakeDeepLocator(deepLocatorFrame);
  const wrappedDeepLocator = (selector: string) => {
    const delegate = fakeDeepLocator(selector);
    return {
      ...delegate,
      nth: (index: number) => {
        const nthDelegate = fakeDeepLocator(selector).nth(index);
        return {
          ...nthDelegate,
          click: async () => {
            await nthDelegate.click();
            if (targetIndex !== null && index === targetIndex) {
              childUrls.current = `${CHILD_ORIGIN}/application/abc-123/basic-info`;
            }
          },
        };
      },
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
    deepLocator: wrappedDeepLocator,
  } as unknown as import("@browserbasehq/stagehand").Page;
}

/**
 * Fake `Stagehand`: `observe()` is blind (`[]`) for the "Manual Application"
 * click step across every scoping (focused, unfocused, and — via the
 * shared fallthrough — top-frame), forcing that one step through the
 * `resolveDeepLocatorCandidates` fallback under test; every other
 * frame-scoped step (First/Last Name fill, Submit) resolves normally,
 * mirroring `flow-runner.iframe-e2e.test.ts`'s
 * `makeFakeStagehandForAcceptanceSequence`. `act(instruction: string)`
 * (attempt 1, every step) always phantom-fails, forcing every step through
 * attempt 2's observe-act path.
 */
function makeDenseStagehand(childUrls: { current: string }, state: AcceptanceSequenceState) {
  const hopPrefix = `${IFRAME_SELECTOR} >> `;
  return {
    act: async (input: unknown) => {
      if (typeof input === "object" && input !== null && "selector" in input) {
        const candidate = input as { selector: unknown };
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
      return {
        success: false,
        message: "no actionable candidate",
        actionDescription: typeof input === "string" ? input : MANUAL_APPLICATION_STEP,
        actions: [],
      };
    },
    observe: async (instruction?: unknown, options?: { selector?: string }) => {
      const isFrameScoped = options?.selector?.startsWith(hopPrefix) ?? false;
      if (!isFrameScoped) return TOP_FRAME_CANDIDATES;
      if (instruction === FIRST_NAME_STEP) return [FIRST_NAME_CANDIDATE];
      if (instruction === LAST_NAME_STEP) return [LAST_NAME_CANDIDATE];
      if (instruction === SUBMIT_STEP) return [SUBMIT_CANDIDATE];
      // "Manual Application" (both focused and unfocused) and any other
      // instruction fall through here — blind, by design.
      return [];
    },
  } as unknown as import("@browserbasehq/stagehand").Stagehand;
}

const ACCEPTANCE_STEPS: HealingFlowStep[] = [
  { instruction: MANUAL_APPLICATION_STEP, optional: false, upload: false, submitStep: false },
  { instruction: FIRST_NAME_STEP, optional: false, upload: false, submitStep: false },
  { instruction: LAST_NAME_STEP, optional: false, upload: false, submitStep: false },
  { instruction: UPLOAD_STEP, optional: false, upload: true, submitStep: false },
  { instruction: SUBMIT_STEP, optional: false, upload: false, submitStep: true },
];

describe("flow-runner dense OOPIF acceptance regression (uchealth-7, offline fixture, no network)", () => {
  beforeEach(() => {
    loggerStub.warn.mockClear();
  });

  it("clicks 'Manual Application' — last of 371 candidates — over four decoys (two layout-less) and 366 filler nodes, then carries frame scope through fill -> upload -> a verified submit", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const state: AcceptanceSequenceState = {
      filledWith: new Map(),
      fileInputCount: 1,
      uploadedFileName: null,
      submitted: false,
    };
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const order = buildDenseHopOrder(true);
    expect(order).toHaveLength(371);
    const hop = registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, order);
    const targetIndex = order.length - 1;

    const stagehand = makeDenseStagehand(childUrls, state);
    const page = makeDenseTopPage(topUrl, childUrls, deepLocatorFrame, state, targetIndex);

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: ACCEPTANCE_STEPS,
      logger: SILENT_LOGGER,
      anthropic: null,
      resumeFixture: {
        buffer: Buffer.from("pdf-bytes"),
        name: "resume.pdf",
        mimeType: "application/pdf",
      },
      frameSelector: IFRAME_SELECTOR,
      submittedStateSelectors: [SUBMITTED_STATE_SELECTOR],
    });

    expect(result.lastStepIndex).toBe(ACCEPTANCE_STEPS.length - 1);
    expect(result.submitStepSkipped).toBe(false);
    expect(result.submitVerified).toBe(true);

    // Only the real, last-in-DOM-order button was ever clicked — not a
    // decoy, not a layout-less duplicate, not a filler node.
    expect(hop.elements[targetIndex]?.clicks).toBeGreaterThan(0);
    for (const [index, element] of hop.elements.entries()) {
      if (index === targetIndex) continue;
      expect(element.clicks).toBe(0);
    }

    expect(state.filledWith.get(FIRST_NAME_CANDIDATE.selector)).toBe("Jane");
    expect(state.filledWith.get(LAST_NAME_CANDIDATE.selector)).toBe("Doe");
    expect(state.uploadedFileName).toBe("resume.pdf");
    expect(state.submitted).toBe(true);
    expect(childUrls.current).toBe(THANK_YOU_URL);

    // Issue #1: the batched single-round-trip scan enumerated all 371
    // candidates without exceeding the legacy loop's abort budget.
    expect(loggerStub.warn).not.toHaveBeenCalledWith(
      expect.stringMatching(/enumeration.*aborted/i)
    );
    // Issue #2: the two layout-less decoys were dropped by the resolver's
    // visibility filter BEFORE any click was attempted against them — proof
    // the -32000 "no layout object" failure never had a chance to fire.
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringMatching(/dropped 2 unrendered candidate/)
    );
    expect(loggerStub.warn).not.toHaveBeenCalledWith(expect.stringMatching(/-32000/));
  });

  it("negative control: with 'Manual Application' absent from the same 370-node hop, the click step exhausts the cascade and the run never reaches fill/upload/submit", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const state: AcceptanceSequenceState = {
      filledWith: new Map(),
      fileInputCount: 0,
      uploadedFileName: null,
      submitted: false,
    };
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const order = buildDenseHopOrder(false);
    expect(order).toHaveLength(370);
    registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, order);

    const stagehand = makeDenseStagehand(childUrls, state);
    // No element ever matches "Manual Application", so no index should ever
    // be treated as the target — targetIndex: null makes every click a no-op.
    const page = makeDenseTopPage(topUrl, childUrls, deepLocatorFrame, state, null);

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: ACCEPTANCE_STEPS,
        logger: SILENT_LOGGER,
        anthropic: null,
        resumeFixture: {
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
