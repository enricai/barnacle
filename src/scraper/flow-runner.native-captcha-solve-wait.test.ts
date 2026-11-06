import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-native-captcha-solve-wait-test";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "recon-native-solve-wait-"));

import {
  awaitNativeCaptchaSolve,
  isNativeCaptchaSolveStalled,
  wireSignalCapture,
} from "@/scraper/flow-runner";

function fake() {
  const handlers = new Map<string, (e: unknown) => void>();
  const session = {
    on: (n: string, h: (e: unknown) => void) => handlers.set(n, h),
    off: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
  };
  const page = {
    getSessionForFrame: () => session,
    mainFrameId: () => "m",
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
  wireSignalCapture(page, {
    counter: { n: 0 },
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    getCurrentPhase: () => "flow",
    getCurrentPageOrigin: () => "",
  });
  const emit = (v: string) =>
    handlers.get("Runtime.consoleAPICalled")?.({ args: [{ type: "string", value: v }] });
  return { page, emit, session };
}

describe("native captcha solve wait", () => {
  it("no events: returns idle immediately", async () => {
    const { page } = fake();
    expect(await awaitNativeCaptchaSolve(page, 50)).toBe("idle");
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });
  it("enables Runtime", () => {
    expect(fake().session.send).toHaveBeenCalledWith("Runtime.enable");
  });
  it("started without finish: waits to bound then stalled", async () => {
    const { page, emit } = fake();
    emit("browserbase-solving-started");
    expect(await awaitNativeCaptchaSolve(page, 30)).toBe("stalled");
    expect(isNativeCaptchaSolveStalled(page)).toBe(true);
  });
  it("finish releases the wait, then settles", async () => {
    const { page, emit } = fake();
    emit("browserbase-solving-started");
    const p = awaitNativeCaptchaSolve(page, 5_000);
    let done = false;
    void p.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    emit("browserbase-solving-finished");
    expect(await p).toBe("finished");
    expect(page.waitForTimeout).toHaveBeenCalledTimes(1);
    expect(isNativeCaptchaSolveStalled(page)).toBe(false);
  });
});
