import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import {
  buildScanFrameCandidatesExpr,
  INTERACTIVE_CANDIDATE_SELECTOR,
} from "@/scraper/deep-locator-scan";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import { WatchdogTimeoutError } from "@/scraper/watchdog";
import type { Logger } from "@/types/logging";

/**
 * Pins bugfix-001 (recon-n16-trusted-click-fails-silently-falls-back-to-
 * synthetic.md): `attemptN16TrustedClick`'s two top-window failure branches —
 * a `WatchdogTimeoutError` from the guarded `.locator().first().click()`
 * call, and any other throw from that same call — must surface a
 * path-specific `trustedClickReason`/`trustedClickError` pair on the `n+16
 * probe:` log line instead of being silently discarded into
 * `delivery=synthetic-fallback` with no further signal. Site-agnostic
 * fixture (a generic wizard "Continue" step), not any real site or plugin.
 */

const BASE_URL = "https://wizard.example.com/step/1";
const STEP_INSTRUCTION = "Click 'Continue' to advance";

function makeLogger(): { logger: Logger; infoLines: string[] } {
  const infoLines: string[] = [];
  const logger = {
    info: vi.fn((msg: string) => infoLines.push(msg)),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  return { logger, infoLines };
}

function makePageWithClick(click: () => Promise<void>): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: async () => ({ fired: false }),
    url: () => BASE_URL,
    title: async () => "Wizard — Step 1",
    locator: () => ({
      first: () => ({
        click,
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

function makeStagehand(): Stagehand {
  return {
    // act() never delivers a real click in this fixture — only n+16's own
    // trusted-click primitive (under test) can, so healing never happens and
    // the n+16 probe line always fires.
    act: vi.fn().mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: STEP_INSTRUCTION,
      actions: [{ selector: "xpath=//button[1]", description: "Continue", method: "click" }],
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;
}

const STEPS: HealingFlowStep[] = [
  { instruction: STEP_INSTRUCTION, optional: false, upload: false, submitStep: false },
];

describe("flow-runner n+16 fallback — attemptN16TrustedClick surfaces its real failure reason", () => {
  it("logs trustedClickReason=timeout and a non-empty trustedClickError when the trusted click watchdog fires", async () => {
    const { logger, infoLines } = makeLogger();
    // withWatchdog races the click() call against its own timer and
    // propagates whichever settles first — a click() that rejects with a
    // WatchdogTimeoutError directly exercises attemptN16TrustedClick's
    // `instanceof WatchdogTimeoutError` classification identically to a
    // real timer expiry, without paying for MAX_STEP_ATTEMPTS real timeouts.
    const page = makePageWithClick(() =>
      Promise.reject(new WatchdogTimeoutError("n+16 fallback: trusted click delivery", 3_000))
    );

    // Every attempt's evaluate() fallback also reports fired:false, so the
    // step never heals — this only exercises attemptN16TrustedClick's
    // failure-reason surfacing, not a healed outcome.
    await expect(
      runHealingFlow({
        stagehand: makeStagehand(),
        page,
        steps: STEPS,
        logger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      })
    ).rejects.toThrow();

    const n16ProbeLines = infoLines.filter((line) => line.includes("n+16 probe"));
    expect(n16ProbeLines.some((line) => line.includes("delivery=synthetic-fallback"))).toBe(true);
    const failureLine = n16ProbeLines.find((line) => line.includes("trustedClickReason="));
    expect(failureLine).toBeDefined();
    expect(failureLine).toContain("trustedClickReason=timeout");
    expect(failureLine).toMatch(/trustedClickError=\S+/);
  });

  it("logs trustedClickReason=threw and the original error's message when the trusted click rejects", async () => {
    const { logger, infoLines } = makeLogger();
    const page = makePageWithClick(() =>
      Promise.reject(new Error("click intercepted by another element"))
    );

    await expect(
      runHealingFlow({
        stagehand: makeStagehand(),
        page,
        steps: STEPS,
        logger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      })
    ).rejects.toThrow();

    const n16ProbeLines = infoLines.filter((line) => line.includes("n+16 probe"));
    expect(n16ProbeLines.some((line) => line.includes("delivery=synthetic-fallback"))).toBe(true);
    const failureLine = n16ProbeLines.find((line) => line.includes("trustedClickReason="));
    expect(failureLine).toBeDefined();
    expect(failureLine).toContain("trustedClickReason=threw");
    expect(failureLine).toContain("trustedClickError=click intercepted by another element");
  });
});

// --- OOPIF branch: frameTarget.frame is resolved, so attemptN16TrustedClick
// takes resolveDeepLocatorCandidatesWithWidening + clickDeepLocatorCandidate
// instead of the top-window locator().click() path exercised above.

const OOPIF_TOP_URL = "https://wizard.example.com/apply";
const OOPIF_CHILD_SRC = "https://apply.example.com/form";
const OOPIF_IFRAME_SELECTOR = "iframe#apply_frame";
const OOPIF_STEP_INSTRUCTION = "Click 'Continue' to advance";
const OOPIF_SCAN_EXPR = buildScanFrameCandidatesExpr(INTERACTIVE_CANDIDATE_SELECTOR);
const OOPIF_WIDENED_SCAN_EXPR = buildScanFrameCandidatesExpr("*");

/**
 * Minimal OOPIF `Page`/child-`Frame` pair (same probe/attach shape
 * `flow-runner.oopif-click-throughput.test.ts` exercises): `scanResults`
 * seeds both the scoped (`INTERACTIVE_CANDIDATE_SELECTOR`) and widened
 * (`"*"`) batched-scan hops with the SAME result set, so
 * `resolveDeepLocatorCandidatesWithWidening`'s widening pass — reached
 * whenever the scoped pass resolves zero — is exercised identically to the
 * scoped pass rather than needing a second fixture surface. `clickOutcome`
 * drives `page.deepLocator(...).nth(...).click()`, the only click primitive
 * `attemptN16TrustedClick` reaches under `preferTrustedClick: true`
 * (`clickDeepLocatorCandidate` skips its own batched-click fast path in that
 * mode).
 */
function makeOopifPage(
  scanResults: Array<{ index: number; text: string; visible: boolean }>,
  clickOutcome: () => Promise<void>
): Page {
  const session = { on: () => {}, off: () => {} };
  const childFrame = {
    evaluate: async (expr: unknown) => {
      if (expr === "location.href") return OOPIF_CHILD_SRC;
      if (expr === OOPIF_SCAN_EXPR || expr === OOPIF_WIDENED_SCAN_EXPR) {
        return scanResults.map((r) => ({ ...r, isNav: false }));
      }
      // Every OTHER evaluate against this frame is the synthetic
      // evaluate()-based activation/probe machinery (clickExpr,
      // ancestor-invalid probe, snapshotPage's signature reads) — this
      // fixture only exercises attemptN16TrustedClick's own failure-reason
      // surfacing, so it reports "nothing fired, nothing changed" for all
      // of those, same as the top-window fixtures' `evaluate: async () =>
      // ({ fired: false })`.
      return { fired: false };
    },
    locator: () => ({
      first: () => ({ isChecked: async () => false, inputValue: async () => "" }),
    }),
  };
  return {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      if (src.includes(JSON.stringify(OOPIF_IFRAME_SELECTOR))) {
        return { matched: true, src: OOPIF_CHILD_SRC };
      }
      return { matched: false, src: null };
    },
    url: () => OOPIF_TOP_URL,
    title: async () => "Wizard — apply",
    locator: () => ({
      first: () => ({ isChecked: async () => false, inputValue: async () => "" }),
    }),
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
    frames: () => [childFrame],
    deepLocator: () => ({
      count: async () => scanResults.length,
      first: () => ({ click: clickOutcome }),
      nth: () => ({ click: clickOutcome }),
      click: clickOutcome,
      fill: async () => {},
      selectOption: async () => [],
      inputValue: async () => "",
      textContent: async () => "",
    }),
  } as unknown as Page;
}

function makeOopifStagehand(): Stagehand {
  return {
    act: vi.fn().mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: OOPIF_STEP_INSTRUCTION,
      actions: [{ selector: "xpath=//button[1]", description: "Continue", method: "click" }],
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;
}

const OOPIF_STEPS: HealingFlowStep[] = [
  { instruction: OOPIF_STEP_INSTRUCTION, optional: false, upload: false, submitStep: false },
];

describe("flow-runner n+16 fallback — attemptN16TrustedClick surfaces its real failure reason (OOPIF branch)", () => {
  it("logs trustedClickReason=no-candidate when resolveDeepLocatorCandidatesWithWidening resolves zero candidates", async () => {
    const { logger, infoLines } = makeLogger();
    const page = makeOopifPage([], async () => {
      throw new Error("click() should never be reached with zero candidates");
    });

    await expect(
      runHealingFlow({
        stagehand: makeOopifStagehand(),
        page,
        steps: OOPIF_STEPS,
        logger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        frameSelector: OOPIF_IFRAME_SELECTOR,
      })
    ).rejects.toThrow();

    const n16ProbeLines = infoLines.filter((line) => line.includes("n+16 probe"));
    expect(n16ProbeLines.some((line) => line.includes("delivery=synthetic-fallback"))).toBe(true);
    const failureLine = n16ProbeLines.find((line) => line.includes("trustedClickReason="));
    expect(failureLine).toBeDefined();
    expect(failureLine).toContain("trustedClickReason=no-candidate");
    expect(failureLine).toContain("trustedClickError=no candidates resolved");
  });

  it("logs trustedClickReason=not-actionable and the last candidate's message when every resolved candidate's click rejects", async () => {
    const { logger, infoLines } = makeLogger();
    const page = makeOopifPage([{ index: 0, text: "Continue", visible: true }], () =>
      Promise.reject(new Error("click intercepted by an overlay"))
    );

    await expect(
      runHealingFlow({
        stagehand: makeOopifStagehand(),
        page,
        steps: OOPIF_STEPS,
        logger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        frameSelector: OOPIF_IFRAME_SELECTOR,
      })
    ).rejects.toThrow();

    const n16ProbeLines = infoLines.filter((line) => line.includes("n+16 probe"));
    expect(n16ProbeLines.some((line) => line.includes("delivery=synthetic-fallback"))).toBe(true);
    const failureLine = n16ProbeLines.find((line) => line.includes("trustedClickReason="));
    expect(failureLine).toBeDefined();
    expect(failureLine).toContain("trustedClickReason=not-actionable");
    expect(failureLine).toContain("trustedClickError=click intercepted by an overlay");
  });
});
