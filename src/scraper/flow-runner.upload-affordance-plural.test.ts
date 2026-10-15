import type { Page } from "@browserbasehq/stagehand";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isUploadAffordanceLabel,
  simulateDragDropUpload,
  surfaceAndUpload,
} from "@/scraper/flow-runner";
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

describe("simulateDragDropUpload with an attribute-identified drop zone", () => {
  it("drops the fixture on a zone matched only by data-testid", async () => {
    const window = new Window();
    window.document.body.innerHTML = `<div data-testid="File-Drop-Area"></div>`;
    const zone = window.document.querySelector("[data-testid]") as unknown as {
      addEventListener: (n: string, f: () => void) => void;
    };
    const seen: string[] = [];
    for (const n of ["dragenter", "dragover", "drop"]) zone.addEventListener(n, () => seen.push(n));
    const globals = {
      document: window.document,
      File: window.File,
      DataTransfer: window.DataTransfer,
      DragEvent: window.DragEvent,
    };
    const target = {
      evaluate: (expr: string): Promise<unknown> => {
        const names = Object.keys(globals);
        const fn = new Function(...names, `return ${expr};`);
        return fn(...Object.values(globals));
      },
    } as unknown as FrameTarget;

    const ok = await simulateDragDropUpload(
      target,
      { name: "r.pdf", mimeType: "application/pdf", buffer: Buffer.from("x") },
      logger
    );

    expect(ok).toBe(true);
    expect(seen).toEqual(["dragenter", "dragover", "drop"]);
  });
});

interface FakeBtn {
  text: string;
  hidden: boolean;
  click: ReturnType<typeof vi.fn>;
}

function btn(text: string, hidden: boolean): FakeBtn {
  return { text, hidden, click: vi.fn() };
}

function install(btns: FakeBtn[]): void {
  const els = btns.map((b) => ({
    textContent: b.text,
    click: b.click,
    getAttribute: (n: string): string | null => (n === "aria-hidden" && b.hidden ? "true" : null),
    getBoundingClientRect: (): { width: number; height: number } => ({ width: 10, height: 10 }),
    style: { display: "block", visibility: "visible" },
    closest: (): null => null,
  }));
  g.getComputedStyle = (el: { style: unknown }): unknown => el.style;
  g.document = {
    querySelector: (): null => null,
    querySelectorAll: (): unknown[] => els,
  };
}

async function captureExprs(): Promise<string[]> {
  const exprs: string[] = [];
  const target = {
    frame: { session: { send: () => Promise.resolve(), on: () => {}, off: () => {} } },
    evaluate: (expr: unknown): Promise<unknown> => {
      exprs.push(String(expr));
      return Promise.resolve({ present: String(expr).includes("present: true"), clicked: false });
    },
    locator: () => ({ first: () => ({ setInputFiles: vi.fn() }) }),
    url: () => Promise.resolve("https://x.example.com"),
    title: () => Promise.resolve("x"),
  } as unknown as FrameTarget;
  const page = { waitForTimeout: () => new Promise((r) => setTimeout(r, 5)) } as unknown as Page;
  await surfaceAndUpload({
    page,
    target,
    fixture: { name: "r.pdf", mimeType: "application/pdf", buffer: Buffer.from("x") },
    logger,
    signalCounter: { n: 0 },
    recentCaptureMeta: [],
  } as never).catch(() => false);
  return exprs;
}

describe("upload affordance plural labels in browser expressions", () => {
  afterEach(() => {
    delete g.document;
    delete g.getComputedStyle;
  });

  it.each(["Select files", "Choose Files"])("render-gate reports %s present", async (label) => {
    const gate = (await captureExprs()).find((e) => e.includes("present: true"));
    expect(gate).toBeDefined();
    install([btn(label, false)]);
    expect(run(gate as string)).toEqual({ present: true });
  });

  it.each(["Remove file", "Cancel", "No file"])("render-gate ignores %s", async (label) => {
    const gate = (await captureExprs()).find((e) => e.includes("present: true"));
    install([btn(label, false)]);
    expect(run(gate as string)).toEqual({ present: false });
  });

  it.each(["Select files", "Choose Files"])("click expression clicks %s", async (label) => {
    const click = (await captureExprs()).find((e) => e.includes("chosen.click()"));
    expect(click).toBeDefined();
    const b = btn(label, false);
    install([b]);
    expect(run(click as string)).toMatchObject({ clicked: true });
    expect(b.click).toHaveBeenCalledTimes(1);
  });

  it("click expression leaves Remove file, Cancel and No file alone", async () => {
    const click = (await captureExprs()).find((e) => e.includes("chosen.click()"));
    const decoys = ["Remove file", "Cancel", "No file"].map((t) => btn(t, false));
    install(decoys);
    expect(run(click as string)).toEqual({ clicked: false });
    for (const d of decoys) expect(d.click).not.toHaveBeenCalled();
  });
});
