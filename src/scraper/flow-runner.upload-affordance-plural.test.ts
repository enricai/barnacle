import type { Page } from "@browserbasehq/stagehand";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isUploadAffordanceLabel, surfaceAndUpload } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const g = globalThis as unknown as { document?: unknown; getComputedStyle?: unknown };

const run = (expr: string): unknown => new Function(`return ${expr};`)();

/**
 * Stub DOM for a generic uploader: the only affordance is a button labelled
 * `label`, and the `<input type=file>` mounts only once that button is clicked.
 */
function installLazyUploader(label: string): { inputMounted: () => boolean } {
  let mounted = false;
  const input = { files: { length: 0 } };
  const button = {
    textContent: label,
    click: (): void => {
      mounted = true;
    },
    getAttribute: (): string | null => null,
    getBoundingClientRect: (): { width: number; height: number } => ({ width: 10, height: 10 }),
    style: { display: "block", visibility: "visible" },
    closest: (): null => null,
  };
  g.getComputedStyle = (el: { style: unknown }): unknown => el.style;
  g.document = {
    querySelector: (sel: string): unknown =>
      sel.includes("input[type=file]") && mounted ? input : null,
    querySelectorAll: (sel: string): unknown[] =>
      sel.includes("input[type=file]") ? (mounted ? [input] : []) : [button],
  };
  return { inputMounted: (): boolean => mounted };
}

describe("isUploadAffordanceLabel plural/singular vocabulary", () => {
  it.each(["Select files", "Choose Files", "Select file"])("accepts %s", (label) => {
    expect(isUploadAffordanceLabel(label)).toBe(true);
  });

  it.each(["Cancel", "Remove file", "No file"])("rejects %s", (label) => {
    expect(isUploadAffordanceLabel(label)).toBe(false);
  });
});

describe("surfaceAndUpload with a lazily-mounted input behind a 'Select files' button", () => {
  afterEach(() => {
    delete g.document;
    delete g.getComputedStyle;
  });

  it("clicks the button, attaches via setInputFiles and returns true", async () => {
    const dom = installLazyUploader("Select files");
    const setInputFiles = vi.fn().mockResolvedValue(undefined);
    const evaluate = vi.fn((expr: unknown): Promise<unknown> => {
      const e = String(expr);
      if (e.includes("no drop zone found")) return Promise.resolve({ ok: false });
      if (e.includes("el.files.length > 0")) return Promise.resolve(dom.inputMounted() ? 1 : 0);
      return Promise.resolve(run(e));
    });
    const target = {
      frame: { session: { send: () => Promise.resolve(), on: () => {}, off: () => {} } },
      evaluate,
      locator: () => ({ first: () => ({ setInputFiles }) }),
      url: () => Promise.resolve("https://uploader.example.com"),
      title: () => Promise.resolve("Uploader"),
    } as unknown as FrameTarget;
    const page = { waitForTimeout: () => new Promise((r) => setTimeout(r, 5)) } as unknown as Page;

    const ok = await surfaceAndUpload({
      page,
      target,
      fixture: { name: "r.pdf", mimeType: "application/pdf", buffer: Buffer.from("x") },
      logger,
      signalCounter: { n: 0 },
      recentCaptureMeta: [],
    });

    expect(ok).toBe(true);
    expect(dom.inputMounted()).toBe(true);
    expect(setInputFiles).toHaveBeenCalledTimes(1);
  }, 30_000);
});
