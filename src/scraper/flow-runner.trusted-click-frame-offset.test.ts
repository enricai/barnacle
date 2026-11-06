import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it } from "vitest";

import type { FrameTarget } from "@/scraper/frame-target";
import { dispatchTrustedClick } from "./flow-runner.js";

/** CDP Input.dispatchMouseEvent params this test asserts coordinates on. */
interface MouseArgs {
  x?: number;
  y?: number;
}
type SentCall = { method: string; args: MouseArgs };

function make(
  rect: { x: number; y: number } | null,
  session: boolean
): { sent: SentCall[]; target: FrameTarget; page: Page } {
  const sent: SentCall[] = [];
  const record = async (m: string, a: MouseArgs): Promise<void> =>
    void sent.push({
      method: m,
      args: a,
    });
  // Deliberately partial stand-ins: dispatchTrustedClick only reaches the frame
  // session sender / evaluate and (for a main frame) page.click.
  const target = {
    frame: session ? { session: { send: record } } : {},
    evaluate: async () => rect,
  } as unknown as FrameTarget;
  const page = { sendCDP: record } as unknown as Page;
  return { sent, target, page };
}

describe("dispatchTrustedClick frame offset", () => {
  it("adds frameElement offset when frame.session is truthy", async () => {
    const { sent, target, page } = make({ x: 10, y: 22 }, true);
    await dispatchTrustedClick(page, target, 5, 6);
    expect(sent).toHaveLength(3);
    for (const s of sent) expect([s.args.x, s.args.y]).toEqual([15, 28]);
  });
  it("uses zero offset when frameElement is null", async () => {
    const { sent, target, page } = make(null, true);
    await dispatchTrustedClick(page, target, 5, 6);
    expect([sent[0]?.args.x, sent[0]?.args.y]).toEqual([5, 6]);
  });
  it("uses zero offset when evaluate rejects", async () => {
    const { sent, target, page } = make(null, true);
    target.evaluate = async () => {
      throw new Error("detached");
    };
    await dispatchTrustedClick(page, target, 5, 6);
    expect(sent).toHaveLength(3);
    for (const s of sent) expect([s.args.x, s.args.y]).toEqual([5, 6]);
  });
  it("main frame clicks via page.click unchanged", async () => {
    const calls: number[][] = [];
    const page = {
      click: async (x: number, y: number) => void calls.push([x, y]),
    } as unknown as Page;
    await dispatchTrustedClick(page, { frame: null } as unknown as FrameTarget, 5, 6);
    expect(calls).toEqual([[5, 6]]);
  });
});
