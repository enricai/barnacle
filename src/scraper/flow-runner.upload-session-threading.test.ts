import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Pins the wiring from `stagehand.browserbaseSessionID` through
 * `executeStepWithHealing` into the upload primitive: a remote session pushes
 * the fixture to that session's uploads endpoint, a session without an id never
 * issues a fetch.
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

function setup(opts: { inputTakes: boolean; sessionId?: string }): {
  run: () => Promise<string>;
  setInputFiles: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const signalCounter = { n: 0 };
  const recentCaptureMeta: { method: string; status: number; url: string }[] = [];
  const handlers: Record<string, (p?: object) => void> = {};
  const emitUploadPost = (): void => {
    setTimeout(() => {
      recentCaptureMeta.push({ method: "POST", status: 200, url: "https://x.example.com/upload" });
      signalCounter.n += 1;
    }, 10);
  };
  const setInputFiles = vi.fn((): Promise<void> => {
    if (!opts.inputTakes) return Promise.reject(new Error("detached"));
    emitUploadPost();
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
        stagehand: { browserbaseSessionID: opts.sessionId } as unknown as Stagehand,
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
        uploadFixture: fixture,
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

describe("executeStepWithHealing upload session threading", () => {
  it("puts the stagehand session id in the uploads fetch URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const t = setup({ inputTakes: false, sessionId: "bb-sess-42" });
    expect(await t.run()).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/sessions\/bb-sess-42\/uploads$/);
    expect(t.send).toHaveBeenCalledWith("DOM.setFileInputFiles", {
      files: ["/tmp/.uploads/r.pdf"],
      backendNodeId: 7,
    });
  });

  it("issues no fetch when the stagehand has no session id", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const t = setup({ inputTakes: false });
    await t.run();
    expect(fetchMock).not.toHaveBeenCalled();
    const call = t.send.mock.calls.find((c) => c[0] === "DOM.setFileInputFiles");
    const files = (call?.[1] as { files?: string[] } | undefined)?.files ?? [];
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("/tmp/.uploads/");
  });
});
