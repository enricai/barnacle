import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Pins the upload decision site: a `setInputFiles` that resolves with no
 * `.files` and no upload POST, plus a drop zone that accepts the synthetic drop
 * without registering anything, is unverified and must fall through to the
 * trusted click + chooser route instead of being reported as uploaded.
 */

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const STEP =
  "Upload the resume file using the 'Select files' button in the Resume/CV upload section";
const OTHER_CAPTURE = { method: "GET", status: 200, url: "https://x.example.com/config.json" };

function makeFixture(name: string): { name: string; mimeType: string; buffer: Buffer } {
  return { name, mimeType: "application/pdf", buffer: Buffer.from("x") };
}

function setup(opts: { inputTakes: boolean; fileName: string; seedCapture?: boolean }): {
  run: () => Promise<string>;
  setInputFiles: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const signalCounter = { n: 0 };
  const recentCaptureMeta: { method: string; status: number; url: string }[] = opts.seedCapture
    ? [OTHER_CAPTURE]
    : [];
  const handlers: Record<string, (p?: object) => void> = {};
  const emitUploadPost = (): void => {
    setTimeout(() => {
      recentCaptureMeta.push({ method: "POST", status: 200, url: "https://x.example.com/upload" });
      signalCounter.n += 1;
    }, 10);
  };
  const setInputFiles = vi.fn((): Promise<void> => {
    if (opts.inputTakes) emitUploadPost();
    return Promise.resolve();
  });
  const click = vi.fn((): Promise<void> => {
    handlers["Page.fileChooserOpened"]?.({ backendNodeId: 7 });
    return Promise.resolve();
  });
  const send = vi.fn((method: string): Promise<unknown> => {
    if (method === "DOM.setFileInputFiles") emitUploadPost();
    return Promise.resolve({});
  });
  const session = {
    send,
    on: (ev: string, h: (p?: object) => void): void => {
      handlers[ev] = h;
    },
    off: (): void => {},
  };
  const target = {
    frame: { session },
    frameSelector: null,
    evaluate: (expr: unknown): Promise<unknown> => {
      const e = String(expr);
      if (e.includes("scrollIntoView")) return Promise.resolve({ state: "hit" });
      if (e.includes("present: true")) return Promise.resolve({ present: true });
      if (e.includes("chosen.setAttribute(")) return Promise.resolve({ marked: true, text: "u" });
      if (e.includes("querySelectorAll('input[type=file]').length")) return Promise.resolve(1);
      if (e.includes("no drop zone found"))
        return Promise.resolve({ ok: true, dropZoneTag: "div" });
      return Promise.resolve(false);
    },
    locator: () => ({ click, first: () => ({ click, setInputFiles }) }),
    url: () => Promise.resolve("https://x.example.com"),
    title: () => Promise.resolve("x"),
  } as unknown as FrameTarget;
  const page = { waitForTimeout: () => new Promise((r) => setTimeout(r, 5)) } as unknown as Page;
  return {
    run: () =>
      executeStepWithHealing({
        stagehand: { browserbaseSessionID: "sess-1" } as unknown as Stagehand,
        page,
        frameTarget: target,
        step: STEP,
        optional: false,
        upload: true,
        submitStep: false,
        stepIndex: 0,
        totalSteps: () => 1,
        phase: "flow",
        signalCounter,
        recentCaptures: [],
        recentCaptureMeta,
        anthropic: null,
        rephraseModel: null,
        logger,
        uploadFixture: makeFixture(opts.fileName),
        isFinalStep: false,
        submitEndpointPattern: null,
        submittedStateSelectors: [],
        requireSubmitEndpointMatch: false,
        advanceTransitionBodyPattern: null,
        successUrlFragments: [],
        successPageTitleHints: [],
        ownBackendHostnames: [],
        knownErrorClassPrefixes: [],
        wizardExitButtonLabels: [],
      } as never) as Promise<string>,
    setInputFiles,
    click,
    send,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("tryUploadPrimitive unverified drop", () => {
  it.each([
    ["r.pdf", false],
    ["cv-final.pdf", false],
    ["cv-final.pdf", true],
  ])(
    "falls through to the chooser for %s (unrelated capture: %s)",
    async (fileName, seedCapture) => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);
      const t = setup({ inputTakes: false, fileName, seedCapture });
      expect(await t.run()).toBe("completed");
      expect(t.setInputFiles).toHaveBeenCalled();
      expect(t.click).toHaveBeenCalled();
      expect(t.send).toHaveBeenCalledWith("DOM.setFileInputFiles", {
        files: [`/tmp/.uploads/${fileName}`],
        backendNodeId: 7,
      });
    }
  );

  it("does not click or fetch when setInputFiles produces a real upload POST", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const t = setup({ inputTakes: true, fileName: "r.pdf" });
    expect(await t.run()).toBe("completed");
    expect(t.setInputFiles).toHaveBeenCalled();
    expect(t.click).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
