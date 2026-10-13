import type { Page } from "@browserbasehq/stagehand";
import { afterEach, describe, expect, it, vi } from "vitest";

import { surfaceAndUpload } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const g = globalThis as unknown as { document?: unknown; getComputedStyle?: unknown };

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

const run = (expr: string): unknown => new Function(`return ${expr};`)();

describe("upload affordance aria-hidden decoys", () => {
  afterEach(() => {
    delete g.document;
    delete g.getComputedStyle;
  });

  it("render-gate ignores a decoy-only aria-hidden upload button", async () => {
    const exprs = await captureExprs();
    const gate = exprs.find((e) => e.includes("present: true"));
    expect(gate).toBeDefined();
    install([btn("Upload resume", true)]);
    expect(run(gate as string)).toEqual({ present: false });
    install([btn("Upload resume", true), btn("Upload resume", false)]);
    expect(run(gate as string)).toEqual({ present: true });
  });

  it("click matcher clicks the visible twin, never the aria-hidden decoy", async () => {
    const exprs = await captureExprs();
    const click = exprs.find((e) => e.includes("chosen.click()"));
    expect(click).toBeDefined();
    const decoy = btn("Upload resume", true);
    const real = btn("Upload resume", false);
    install([decoy, real]);
    expect(run(click as string)).toMatchObject({ clicked: true });
    expect(decoy.click).not.toHaveBeenCalled();
    expect(real.click).toHaveBeenCalledTimes(1);
    const only = btn("Upload resume", true);
    install([only]);
    expect(run(click as string)).toEqual({ clicked: false });
    expect(only.click).not.toHaveBeenCalled();
  });
});
