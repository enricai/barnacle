import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { surfaceAndUpload } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Pins that an intercepted native chooser is resolved via CDP BEFORE the
 * existing-input `setInputFiles` strategy, and that a chooser success never
 * calls `setInputFiles`.
 */

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const fixture = { name: "r.pdf", mimeType: "application/pdf", buffer: Buffer.from("x") };

function setup(opts: { chooser: boolean; cdpUploads: boolean }): {
  run: () => Promise<boolean>;
  setInputFiles: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const signalCounter = { n: 0 };
  const recentCaptureMeta: { method: string; status: number; url: string }[] = [];
  const handlers: Record<string, (p?: object) => void> = {};
  const setInputFiles = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn((method: string): Promise<unknown> => {
    if (method === "DOM.setFileInputFiles" && opts.cdpUploads) {
      setTimeout(() => {
        recentCaptureMeta.push({ method: "POST", status: 200, url: "https://x.test/upload" });
        signalCounter.n += 1;
      }, 10);
    }
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
    evaluate: (expr: unknown): Promise<unknown> => {
      const e = String(expr);
      if (e.includes("present: true")) return Promise.resolve({ present: true });
      if (e.includes("chosen.setAttribute(")) return Promise.resolve({ marked: true, text: "u" });
      if (e.includes("querySelectorAll('input[type=file]').length")) return Promise.resolve(1);
      if (e.includes("no drop zone found")) return Promise.resolve({ ok: false });
      return Promise.resolve(false);
    },
    locator: () => ({
      first: () => ({
        click: (): Promise<void> => {
          if (opts.chooser) handlers["Page.fileChooserOpened"]?.({ backendNodeId: 7 });
          return Promise.resolve();
        },
        setInputFiles,
      }),
    }),
    url: () => Promise.resolve("https://x.example.com"),
    title: () => Promise.resolve("x"),
  } as unknown as FrameTarget;
  const page = { waitForTimeout: () => new Promise((r) => setTimeout(r, 5)) } as unknown as Page;
  return {
    run: () =>
      surfaceAndUpload({
        page,
        target,
        fixture,
        logger,
        signalCounter,
        recentCaptureMeta,
        browserbaseSessionId: "sess-1",
      }),
    setInputFiles,
    send,
  };
}

describe("surfaceAndUpload strategy order", () => {
  it("resolves via the intercepted chooser without calling setInputFiles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const t = setup({ chooser: true, cdpUploads: true });
    expect(await t.run()).toBe(true);
    expect(t.send).toHaveBeenCalledWith("DOM.setFileInputFiles", {
      files: ["/tmp/.uploads/r.pdf"],
      backendNodeId: 7,
    });
    expect(t.setInputFiles).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("falls back to setInputFiles when the chooser path fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const t = setup({ chooser: true, cdpUploads: false });
    await t.run();
    const order = [
      t.send.mock.calls.findIndex((c) => c[0] === "DOM.setFileInputFiles"),
      t.setInputFiles.mock.invocationCallOrder[0],
    ];
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(t.setInputFiles).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("runs setInputFiles when no chooser was intercepted", async () => {
    const t = setup({ chooser: false, cdpUploads: false });
    await t.run();
    expect(t.send).not.toHaveBeenCalledWith("DOM.setFileInputFiles", expect.anything());
    expect(t.setInputFiles).toHaveBeenCalled();
  });
});
