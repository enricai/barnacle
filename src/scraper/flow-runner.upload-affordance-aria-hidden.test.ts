import type { Page } from "@browserbasehq/stagehand";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clickUploadAffordance,
  isUploadAffordanceLabel,
  surfaceAndUpload,
} from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import { UPLOAD_AFFORDANCE_MATCHER_EXPR } from "@/scraper/upload-affordance-expr";
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
  mark: ReturnType<typeof vi.fn>;
}

function btn(text: string, hidden: boolean): FakeBtn {
  return { text, hidden, click: vi.fn(), mark: vi.fn() };
}

function install(btns: FakeBtn[]): void {
  const els = btns.map((b) => ({
    textContent: b.text,
    click: b.click,
    setAttribute: b.mark,
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
    const click = exprs.find((e) => e.includes("chosen.setAttribute("));
    expect(click).toBeDefined();
    const decoy = btn("Upload resume", true);
    const real = btn("Upload resume", false);
    install([decoy, real]);
    expect(run(click as string)).toMatchObject({ marked: true });
    expect(decoy.mark).not.toHaveBeenCalled();
    expect(real.mark).toHaveBeenCalledTimes(1);
    expect(real.click).not.toHaveBeenCalled();
    const only = btn("Upload resume", true);
    install([only]);
    expect(run(click as string)).toEqual({ marked: false });
    expect(only.mark).not.toHaveBeenCalled();
  });

  it("clicks via a trusted locator click and removes the marker even when it throws", async () => {
    const calls: string[] = [];
    const click = vi.fn().mockRejectedValue(new Error("boom"));
    const target = {
      frame: {},
      evaluate: (expr: unknown): Promise<unknown> => {
        const e = String(expr);
        calls.push(e);
        return Promise.resolve(
          e.includes("removeAttribute") ? undefined : { marked: true, text: "upload" }
        );
      },
      locator: (sel: string) => ({
        first: () => ({
          click: () => {
            calls.push(`click ${sel}`);
            return click();
          },
        }),
      }),
    } as unknown as FrameTarget;
    const page = { waitForTimeout: () => Promise.resolve() } as unknown as Page;
    const ok = await clickUploadAffordance(page, target, logger);
    expect(ok).toBe(false);
    expect(calls.some((c) => c.startsWith("click [data-barnacle-upload-affordance]"))).toBe(true);
    expect(calls[calls.length - 1]).toContain("removeAttribute");
  });

  it("accepts singular and plural select-file labels, still rejects decliners", () => {
    expect(isUploadAffordanceLabel("Select files")).toBe(true);
    expect(isUploadAffordanceLabel("Select file")).toBe(true);
    expect(isUploadAffordanceLabel("upload later")).toBe(false);
    expect(isUploadAffordanceLabel("no file")).toBe(false);
    expect(isUploadAffordanceLabel("remove file")).toBe(false);
  });

  it("gate and click expressions embed the shared vocabulary source", async () => {
    const exprs = await captureExprs();
    const gate = exprs.find((e) => e.includes("present: true"));
    const click = exprs.find((e) => e.includes("chosen.setAttribute("));
    expect(gate).toContain(UPLOAD_AFFORDANCE_MATCHER_EXPR);
    expect(click).toContain(UPLOAD_AFFORDANCE_MATCHER_EXPR);
    const only = btn("Select files", false);
    install([only]);
    expect(run(click as string)).toMatchObject({ marked: true });
  });
});
