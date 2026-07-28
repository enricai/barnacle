import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as deepLocatorCandidatesModule from "@/scraper/deep-locator-candidates";
import {
  buildScanFrameCandidatesExpr,
  type FrameCandidateScanResult,
} from "@/scraper/deep-locator-scan";
import { probeStepBeforeAttempts } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Behavioral coverage for `probeStepBeforeAttempts`'s pre-cascade
 * reachability gate now that its frame-scoped fallback routes through the
 * batched `frameTarget.evaluate(buildScanFrameCandidatesExpr("*"))` scan
 * (`deep-locator-candidates.ts`'s `scanFrameCandidatesBatched`) instead of
 * the legacy per-candidate `count()`/`nth().textContent()` loop.
 * `flow-runner.deep-locator-fallback.test.ts`'s `makeChildFrameTarget`
 * resolves `evaluate` to snapshotPage's `{html, text}` shape for every call
 * — a non-conforming scan payload — so every one of its cases degrades to
 * the legacy loop and never exercises the batched path this file targets.
 * `evaluate` here instead dispatches on the expression string: the scan
 * expression gets a `FrameCandidateScanResult[]`, anything else (the
 * snapshotPage probe) gets the legacy `{html, text}` shape.
 */

const guardedObserve = vi.fn();

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
  };
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

const FRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const SCAN_EXPR = buildScanFrameCandidatesExpr("*");

/**
 * Child `FrameTarget` whose `evaluate` dispatches on the expression string:
 * the probe's own batched-scan expression (`SCAN_EXPR`) resolves to
 * `scanResults`, and anything else (snapshotPage's pre/post probe) resolves
 * to the legacy `{html, text}` shape so those calls don't throw if this
 * target is ever threaded through a caller that also snapshots.
 */
function makeChildFrameTarget(scanResults: FrameCandidateScanResult[]): FrameTarget {
  const evaluate = vi.fn(async (expr: unknown) => {
    if (expr === SCAN_EXPR) return scanResults;
    return { html: 0, text: "0:" };
  });
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: FRAME_SELECTOR,
    evaluate: evaluate as FrameTarget["evaluate"],
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: () => Promise.resolve("https://apply.talemetry.com/application/abc-123"),
    title: () => Promise.resolve("Apply"),
  };
}

/**
 * Fake `page.deepLocator()` that never conforms to a legacy-loop-usable
 * delegate: `count`/`nth` are spies a test can assert were never called,
 * proving the batched scan resolved the candidates without falling through
 * to the O(n) per-candidate round-trip loop.
 */
function makeLegacyLoopSpyDeepLocator() {
  const countSpy = vi.fn();
  const nthSpy = vi.fn();
  const deepLocator = vi.fn(() => ({
    count: countSpy,
    nth: nthSpy,
  }));
  return { deepLocator: deepLocator as unknown as Page["deepLocator"], countSpy, nthSpy };
}

describe("flow-runner/probeStepBeforeAttempts — batched frame scan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves "present" from exactly ONE evaluate call, with zero deepLocator().nth() round-trips, for a dense frame with a laid-out node', async () => {
    guardedObserve.mockResolvedValue([]);
    const { deepLocator, countSpy, nthSpy } = makeLegacyLoopSpyDeepLocator();
    const page = { deepLocator } as unknown as Page;
    const frameTarget = makeChildFrameTarget([
      { index: 0, text: "Manual Application", visible: true },
    ]);

    const result = await probeStepBeforeAttempts({
      stagehand: makeStagehand(),
      page,
      step: "Click Manual Application",
      stepIndex: 0,
      logger: testLogger,
      frameTarget,
    });

    expect(result).toBe("present");
    expect(frameTarget.evaluate).toHaveBeenCalledTimes(1);
    expect(countSpy).not.toHaveBeenCalled();
    expect(nthSpy).not.toHaveBeenCalled();
  });

  it('resolves "absent" when the scan reports candidates but every one is visible:false', async () => {
    guardedObserve.mockResolvedValue([]);
    const { deepLocator, nthSpy } = makeLegacyLoopSpyDeepLocator();
    const page = { deepLocator } as unknown as Page;
    const frameTarget = makeChildFrameTarget([
      { index: 0, text: "Manual Application", visible: false },
      { index: 1, text: "Cancel", visible: false },
    ]);

    const result = await probeStepBeforeAttempts({
      stagehand: makeStagehand(),
      page,
      step: "Click Manual Application",
      stepIndex: 0,
      logger: testLogger,
      frameTarget,
    });

    expect(result).toBe("absent");
    expect(nthSpy).not.toHaveBeenCalled();
  });

  it('resolves "absent" when the scan reports zero matches', async () => {
    guardedObserve.mockResolvedValue([]);
    const { deepLocator, nthSpy } = makeLegacyLoopSpyDeepLocator();
    const page = { deepLocator } as unknown as Page;
    const frameTarget = makeChildFrameTarget([]);

    const result = await probeStepBeforeAttempts({
      stagehand: makeStagehand(),
      page,
      step: "Click Manual Application",
      stepIndex: 0,
      logger: testLogger,
      frameTarget,
    });

    expect(result).toBe("absent");
    expect(nthSpy).not.toHaveBeenCalled();
  });

  it('issues the scan for innerSelector "*" (not the interactive selector) against the already-resolved frameTarget', async () => {
    guardedObserve.mockResolvedValue([]);
    const { deepLocator } = makeLegacyLoopSpyDeepLocator();
    const page = { deepLocator } as unknown as Page;
    const frameTarget = makeChildFrameTarget([
      { index: 0, text: "Manual Application", visible: true },
    ]);
    const resolveDeepLocatorCandidatesSpy = vi.spyOn(
      deepLocatorCandidatesModule,
      "resolveDeepLocatorCandidates"
    );

    const result = await probeStepBeforeAttempts({
      stagehand: makeStagehand(),
      page,
      step: "Click Manual Application",
      stepIndex: 0,
      logger: testLogger,
      frameTarget,
    });

    expect(result).toBe("present");
    // 3rd arg pins innerSelector "*" (the reachability-only probe, not
    // INTERACTIVE_CANDIDATE_SELECTOR); the 5th arg's `frameTarget` is the
    // SAME already-resolved object passed in, so scanFrameCandidatesBatched
    // reuses it instead of re-resolving via its own internal fallback.
    expect(resolveDeepLocatorCandidatesSpy).toHaveBeenCalledWith(
      page,
      FRAME_SELECTOR,
      "*",
      undefined,
      { frameTarget }
    );
    expect(frameTarget.evaluate).toHaveBeenCalledWith(SCAN_EXPR);
    resolveDeepLocatorCandidatesSpy.mockRestore();
  });
});
