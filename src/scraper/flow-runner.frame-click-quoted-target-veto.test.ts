import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeDeepLocatorDelegate } from "@/scraper/deep-locator-fake";
import { makeFakeDeepLocator, registerDeepLocatorHop } from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import { resetBillingErrorFlagForTests, runHealingFlow } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

const guardedObserve = vi.fn();
const guardedAct = vi.fn();
const resolveFrameTarget = vi.fn();
const waitForChildFrameReady = vi.fn().mockResolvedValue(undefined);

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
    guardedAct: (...args: unknown[]) => guardedAct(...args),
  };
});

vi.mock("@/scraper/frame-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/frame-target")>();
  return {
    ...actual,
    resolveFrameTarget: (...args: unknown[]) => resolveFrameTarget(...args),
    waitForChildFrameReady: (...args: unknown[]) => waitForChildFrameReady(...args),
  };
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** `stagehand.act`/`stagehand.observe` are never called directly — flow-runner calls the mocked `guardedAct`/`guardedObserve` — so this only needs to be a distinct, identifiable object passed through untouched. */
function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

const FRAME_SELECTOR = "iframe#apply_frame";

/**
 * Child `FrameTarget` whose `evaluate` answers `snapshotPage`'s `{html,text}`
 * probe so the pre/post captures around each attempt don't throw. `getUrl`
 * backs `url()` with a mutable value so a click that advances the wizard
 * gives `snapshotPage`'s `post.url !== pre.url` check (the cascade's
 * `urlChanged` verification signal) a real reason to fire.
 */
function makeChildFrameTarget(getUrl: () => string): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: FRAME_SELECTOR,
    evaluate: vi.fn().mockResolvedValue({ html: 0, text: "0:" }),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: () => Promise.resolve(getUrl()),
    title: () => Promise.resolve("Apply"),
  };
}

/**
 * Fake page satisfying `wireSignalCapture`'s CDP plumbing plus the plain
 * evaluate/locator surface. `deepLocatorImpl` lets each test swap in a
 * registry-backed fake (frame-scoped success) or an empty one (control case),
 * while still routing through the same object shape flow-runner expects.
 */
function fakeFlowPage(
  getUrl: () => string,
  deepLocatorImpl: (selector: string) => FakeDeepLocatorDelegate
): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    url: getUrl,
    title: vi.fn().mockResolvedValue("Apply"),
    deepLocator: deepLocatorImpl,
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

const ACCEPT_STEP = "If a cookie consent banner is shown, click 'Accept' to dismiss it";
const NEXT_STEP =
  "Click the 'Next' button to submit the email and advance to the Candidate Profile step";

async function run(instruction: string, texts: string[]) {
  const urls = { current: "https://apply.example.com/jobs/1/apply" };
  const frame = new Map();
  const hopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
  for (const t of texts) registerDeepLocatorHop(frame, hopSelector, t);
  registerDeepLocatorHop(frame, `${FRAME_SELECTOR} >> *`, texts[0] ?? "");
  const base = makeFakeDeepLocator(frame);
  const wrap = (d: FakeDeepLocatorDelegate): FakeDeepLocatorDelegate => ({
    ...d,
    click: async () => {
      await d.click();
      urls.current = "https://apply.example.com/jobs/1/apply/next";
    },
    nth: (i: number) => wrap(d.nth(i)),
  });
  const page = fakeFlowPage(
    () => urls.current,
    (sel) => wrap(base(sel))
  );
  resolveFrameTarget.mockImplementation(async () => makeChildFrameTarget(() => urls.current));
  guardedObserve.mockResolvedValue([]);
  guardedAct.mockResolvedValue({
    success: false,
    message: "none",
    actionDescription: "",
    actions: [],
  });
  const info: string[] = [];
  const logger = {
    ...testLogger,
    info: (m: string) => info.push(m),
  } as unknown as Logger;
  await runHealingFlow({
    stagehand: makeStagehand(),
    page,
    steps: [{ instruction, optional: false, upload: false, submitStep: false }],
    logger,
    anthropic: null,
    rephraseModel: null,
    uploadFixture: null,
    frameSelector: FRAME_SELECTOR,
  }).catch(() => undefined);
  const clicks = () => {
    let n = 0;
    for (const hop of frame.values()) {
      n += hop?.clicks ?? 0;
      for (const e of hop?.elements ?? []) n += e?.clicks ?? 0;
    }
    return n;
  };
  return { clicks, info };
}

const REFUSAL = /refusing to click an unrelated control|no frame candidate names a phrase/;

describe("flow-runner frame click quoted-target veto", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
  });

  it("refuses the 'Accept' step when no candidate names it (zero clicks)", async () => {
    const { clicks, info } = await run(ACCEPT_STEP, ["Skip to Main Content", "Privacy Policy"]);
    expect(clicks()).toBe(0);
    expect(info.some((m) => REFUSAL.test(m))).toBe(true);
  });

  it("still clicks a 'Next' candidate for the 'Next' step", async () => {
    const { clicks, info } = await run(NEXT_STEP, ["Skip to Main Content", "Next"]);
    expect(clicks()).toBeGreaterThan(0);
    expect(info.some((m) => /refusing to click an unrelated control/.test(m))).toBe(false);
  });

  it("does not veto a value-quoting step", async () => {
    const { info } = await run(
      "Click the 'Yes' answer for the question 'Are you at least 18 years old?'",
      ["Skip to Main Content"]
    );
    expect(info.some((m) => /no frame candidate names a phrase/.test(m))).toBe(false);
  });
});
