import type { Action, Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import {
  attachToSurfacedInput,
  dispatchJqueryChangeEvent,
  simulateDragDropUpload,
  surfaceAndUpload,
  verifyDomEffect,
} from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for the locate-in-frame / act-on-main-frame mismatch:
 * `attachToSurfacedInput`, `surfaceAndUpload`, and `verifyDomEffect` all
 * resolve/locate elements through a caller-supplied child `FrameTarget`, but
 * previously dispatched the follow-up effect (`simulateDragDropUpload`,
 * `dispatchJqueryChangeEvent`) against `mainFrameTarget(page)` — a different
 * document for a cross-origin iframe. Each test below asserts the dispatch
 * target is the SAME object the caller passed in as the locate target, using
 * a child `FrameTarget` whose `evaluate` is distinguishable from `page.evaluate`.
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

/** Fake `Page` whose `evaluate` is a distinct spy from the child target's, so a call reaching it (instead of the child target) is detectable. */
function makeFakePage(): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        setInputFiles: vi.fn().mockResolvedValue(undefined),
        inputValue: vi.fn().mockResolvedValue(""),
        isChecked: vi.fn().mockResolvedValue(false),
        fill: vi.fn().mockResolvedValue(undefined),
        type: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
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

describe("flow-runner/simulateDragDropUpload — frame targeting", () => {
  it("evaluates the drag-drop dispatch via the resolved child frame, not page.evaluate", async () => {
    const targetEvaluate = vi.fn().mockResolvedValue({ ok: true, dropZoneTag: "uapp-upload" });
    const target = makeChildTarget(targetEvaluate);

    const result = await simulateDragDropUpload(target, fixture, testLogger);

    expect(result).toBe(true);
    expect(targetEvaluate).toHaveBeenCalledTimes(1);
  });
});

describe("flow-runner/attachToSurfacedInput — drag-drop fallback frame targeting", () => {
  it("falls back to simulateDragDropUpload against the SAME child target it located the input through, not mainFrameTarget(page)", async () => {
    const page = makeFakePage();
    const childEvaluate = vi
      .fn()
      // change-dispatch after setInputFiles: report no file attached
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
    // All three evaluate calls (change-dispatch, DOM-attach check, drag-drop)
    // must have gone through the child target — page.evaluate must never fire.
    expect(childEvaluate).toHaveBeenCalledTimes(3);
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

describe("flow-runner/surfaceAndUpload — dropzone-strategy frame targeting", () => {
  it("dispatches the dropzone-strategy drag-drop against the SAME child target passed in as params.target, not mainFrameTarget(page)", async () => {
    const page = makeFakePage();
    const childEvaluate = vi
      .fn()
      // render-gate poll: upload target present
      .mockResolvedValueOnce({ present: true })
      // simulateDragDropUpload's own evaluate — must land on the child target
      .mockResolvedValueOnce({ ok: true, dropZoneTag: "uapp-upload" });
    const target = makeChildTarget(childEvaluate);
    const signalCounter = { n: 0 };
    const recentCaptureMeta: { method: string; status: number; url: string }[] = [];
    // waitForUploadNetworkSignal polls via page.waitForTimeout; bump the
    // signal counter and append the matching capture on the first poll so
    // the drag-drop-onto-dropzone success path resolves immediately instead
    // of grinding out its full timeout.
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
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

describe("flow-runner/dispatchJqueryChangeEvent — frame targeting", () => {
  it("evaluates the change/input/blur dispatch via the resolved child frame, not page.evaluate", async () => {
    const targetEvaluate = vi.fn().mockResolvedValue("dispatched");
    const target = makeChildTarget(targetEvaluate);

    await dispatchJqueryChangeEvent(target, "xpath=//input[@id='fname']");

    expect(targetEvaluate).toHaveBeenCalledTimes(1);
  });
});

describe("flow-runner/verifyDomEffect — change-dispatch frame targeting", () => {
  it("dispatches the post-fill jQuery-change event against the SAME child target it located the field through, not mainFrameTarget(page)", async () => {
    const dispatchEvaluate = vi.fn().mockResolvedValue("dispatched");
    const fillLocator = {
      first: () => ({
        inputValue: vi.fn().mockResolvedValue("Jane"),
        fill: vi.fn().mockResolvedValue(undefined),
        type: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const target: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: "iframe#talemetry_apply_iframe",
      evaluate: dispatchEvaluate as FrameTarget["evaluate"],
      locator: vi.fn().mockReturnValue(fillLocator) as unknown as FrameTarget["locator"],
      url: () => Promise.resolve("https://apply.talemetry.com/application/abc-123"),
      title: () => Promise.resolve("Apply"),
    };
    const action: Action = {
      selector: "xpath=//input[@id='fname']",
      method: "fill",
      arguments: ["Jane"],
      description: "First name",
    } as Action;

    const hit = await verifyDomEffect(target, action);

    expect(hit).toBe(true);
    // dispatchJqueryChangeEvent's evaluate must have gone through the same
    // child target verifyDomEffect used for target.locator(selector), not page.
    expect(dispatchEvaluate).toHaveBeenCalledTimes(1);
  });
});
