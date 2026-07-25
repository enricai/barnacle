import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { attachToSurfacedInput, surfaceAndUpload } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import { mainFrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for the two `simulateDragDropUpload` call sites in
 * `attachToSurfacedInput` (post-setInputFiles fallback) and `surfaceAndUpload`
 * (Strategy DZ): both locate through a caller-supplied `FrameTarget` and must
 * dispatch the synthetic drop against that SAME target, not unconditionally
 * against `mainFrameTarget(page)`. Complements
 * `flow-runner.frame-upload-verify.test.ts` (which proves the child-frame
 * case for these two sites) by also pinning that a main-frame target still
 * routes through `page.evaluate` unchanged.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeChildTarget(evaluateImpl: (expr: unknown) => Promise<unknown>): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: "iframe#talemetry_apply_iframe",
    evaluate: evaluateImpl as FrameTarget["evaluate"],
    locator: (selector: string) =>
      ({
        scope: "frame" as const,
        selector,
        first: () => ({ setInputFiles: vi.fn().mockResolvedValue(undefined) }),
      }) as never,
    url: () => Promise.resolve("https://apply.talemetry.com/application/abc-123"),
    title: () => Promise.resolve("Apply"),
  };
}

/**
 * `waitForTimeout` backs a real wall-clock poll loop in
 * `waitForUploadNetworkSignal` (`performance.now()`-gated, not
 * `setTimeout`-gated) — resolving it instantly would spin that loop as fast
 * as the CPU allows for the full real-time window instead of actually
 * waiting, generating unbounded garbage. Delegate to a real (short) delay so
 * the loop only iterates a handful of times.
 */
function makeFakePage(pageEvaluate: ReturnType<typeof vi.fn>): Page {
  return {
    evaluate: pageEvaluate,
    locator: vi.fn().mockReturnValue({
      first: () => ({ setInputFiles: vi.fn().mockResolvedValue(undefined) }),
    }),
    waitForTimeout: vi.fn((ms: number) => new Promise((res) => setTimeout(res, ms))),
    getSessionForFrame: vi
      .fn()
      .mockReturnValue({ send: vi.fn().mockResolvedValue({}), on: vi.fn() }),
    mainFrameId: vi.fn().mockReturnValue("main"),
  } as unknown as Page;
}

const fixture = {
  buffer: Buffer.from("pdf-bytes"),
  name: "resume.pdf",
  mimeType: "application/pdf",
};

describe("flow-runner/attachToSurfacedInput — drag-drop fallback frame scope", () => {
  it("dispatches against the child target when the upload input lives in a cross-origin iframe", async () => {
    const pageEvaluate = vi.fn().mockResolvedValue(null);
    const page = makeFakePage(pageEvaluate);
    const childEvaluate = vi
      .fn()
      // framework-wrapper change dispatch: no file registered
      .mockResolvedValueOnce(false)
      // DOM-attached fallback check: no file in DOM
      .mockResolvedValueOnce(0)
      // simulateDragDropUpload's own evaluate — must land on the child target
      .mockResolvedValueOnce({ ok: true, dropZoneTag: "uapp-upload" });
    const target = makeChildTarget(childEvaluate);

    const result = await attachToSurfacedInput({
      page,
      target,
      fixture,
      logger: testLogger,
      signalCounter: { n: 0 },
      recentCaptureMeta: [],
    });

    expect(result).toBe(true);
    expect(childEvaluate).toHaveBeenCalledTimes(3);
    expect(pageEvaluate).not.toHaveBeenCalled();
  });

  it("still dispatches via page.evaluate when the target is the main frame (unchanged top-frame behavior)", async () => {
    const pageEvaluate = vi
      .fn()
      // framework-wrapper change dispatch: no file registered
      .mockResolvedValueOnce(false)
      // DOM-attached fallback check: no file in DOM
      .mockResolvedValueOnce(0)
      // simulateDragDropUpload's own evaluate — must land on page.evaluate
      .mockResolvedValueOnce({ ok: true, dropZoneTag: "uapp-upload" });
    const page = makeFakePage(pageEvaluate);
    const target = mainFrameTarget(page);

    const result = await attachToSurfacedInput({
      page,
      target,
      fixture,
      logger: testLogger,
      signalCounter: { n: 0 },
      recentCaptureMeta: [],
    });

    expect(result).toBe(true);
    expect(pageEvaluate).toHaveBeenCalledTimes(3);
  });
});

describe("flow-runner/surfaceAndUpload — Strategy DZ frame scope", () => {
  it("dispatches the dropzone-strategy drag-drop against the child target, not page.evaluate", async () => {
    const pageEvaluate = vi.fn().mockResolvedValue(null);
    const page = makeFakePage(pageEvaluate);
    const childEvaluate = vi
      .fn()
      // render-gate poll: upload target present
      .mockResolvedValueOnce({ present: true })
      // simulateDragDropUpload's own evaluate — must land on the child target
      .mockResolvedValueOnce({ ok: true, dropZoneTag: "uapp-upload" });
    const target = makeChildTarget(childEvaluate);
    const signalCounter = { n: 0 };
    const recentCaptureMeta: { method: string; status: number; url: string }[] = [];
    (page.waitForTimeout as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      signalCounter.n = 1;
      recentCaptureMeta.push({
        method: "POST",
        status: 200,
        url: "https://apply.talemetry.com/attachment_upload",
      });
    });

    const result = await surfaceAndUpload({
      page,
      target,
      fixture,
      logger: testLogger,
      signalCounter,
      recentCaptureMeta,
    });

    expect(result).toBe(true);
    expect(childEvaluate).toHaveBeenCalledTimes(2);
    expect(pageEvaluate).not.toHaveBeenCalled();
  });

  it("still dispatches Strategy DZ via page.evaluate when the target is the main frame (unchanged top-frame behavior)", async () => {
    const pageEvaluate = vi
      .fn()
      // render-gate poll: upload target present
      .mockResolvedValueOnce({ present: true })
      // simulateDragDropUpload's own evaluate — must land on page.evaluate
      .mockResolvedValueOnce({ ok: true, dropZoneTag: "uapp-upload" });
    const page = makeFakePage(pageEvaluate);
    const target = mainFrameTarget(page);
    const signalCounter = { n: 0 };
    const recentCaptureMeta: { method: string; status: number; url: string }[] = [];
    (page.waitForTimeout as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      signalCounter.n = 1;
      recentCaptureMeta.push({
        method: "POST",
        status: 200,
        url: "https://apply.talemetry.com/attachment_upload",
      });
    });

    const result = await surfaceAndUpload({
      page,
      target,
      fixture,
      logger: testLogger,
      signalCounter,
      recentCaptureMeta,
    });

    expect(result).toBe(true);
    expect(pageEvaluate).toHaveBeenCalledTimes(2);
  });
});
