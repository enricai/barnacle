import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Pins the `tryUploadPrimitive` decision site for a `setInputFiles` that
 * RESOLVES without attaching (no upload POST, no file in the DOM): the
 * existing input plus a non-throwing call must not end the decision, so the
 * surfaced-upload path runs with the session id. A `setInputFiles` that takes
 * must never reach it. Observed through the click, CDP send and upload fetch.
 */

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const STEP =
  "Upload the resume file using the 'Select files' button in the Resume/CV upload section";
const fixture = { name: "r.pdf", mimeType: "application/pdf", buffer: Buffer.from("x") };

function setup(opts: { inputTakes: boolean; fileName?: string }): {
  run: () => Promise<string>;
  setInputFiles: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const signalCounter = { n: 0 };
  const recentCaptureMeta: { method: string; status: number; url: string; hasBody?: boolean }[] =
    [];
  const handlers: Record<string, (p?: object) => void> = {};
  const emitUploadPost = (): void => {
    setTimeout(() => {
      recentCaptureMeta.push({
        method: "POST",
        status: 200,
        url: "https://x.example.com/upload",
        hasBody: true,
      });
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
      if (e.includes("no drop zone found")) return Promise.resolve({ ok: false });
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
        uploadFixture: opts.fileName ? { ...fixture, name: opts.fileName } : fixture,
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

describe("tryUploadPrimitive resolved-but-unattached input retry", () => {
  it("falls through to click-to-surface when setInputFiles resolves without attaching, threading the session id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const t = setup({ inputTakes: false });
    expect(await t.run()).toBe("completed");
    expect(t.click).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/sessions\/sess-1\/uploads$/);
    expect(init.method).toBe("POST");
    expect(t.send).toHaveBeenCalledWith("DOM.setFileInputFiles", {
      files: ["/tmp/.uploads/r.pdf"],
      backendNodeId: 7,
    });
  });

  it("falls through to surfaceAndUpload with a different file name", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const t = setup({ inputTakes: false, fileName: "cv-other.pdf" });
    expect(await t.run()).toBe("completed");
    expect(t.send).toHaveBeenCalledWith("DOM.setFileInputFiles", {
      files: ["/tmp/.uploads/cv-other.pdf"],
      backendNodeId: 7,
    });
  });

  it("does not click or surface when setInputFiles works", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const t = setup({ inputTakes: true });
    expect(await t.run()).toBe("completed");
    expect(t.setInputFiles).toHaveBeenCalled();
    expect(t.click).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
