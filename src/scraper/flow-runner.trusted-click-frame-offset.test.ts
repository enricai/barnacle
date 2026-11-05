import { describe, expect, it } from "vitest";
import { dispatchTrustedClick } from "./flow-runner.js";

function make(rect: { x: number; y: number } | null, session: boolean) {
  const sent: { method: string; args: any }[] = [];
  const target: any = {
    frame: session
      ? {
          session: {
            send: async (m: string, a: any) => void sent.push({ method: m, args: a }),
          },
        }
      : {},
    evaluate: async () => rect,
  };
  const page: any = {
    sendCDP: async (m: string, a: any) => void sent.push({ method: m, args: a }),
  };
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
  it("main frame clicks via page.click unchanged", async () => {
    const calls: number[][] = [];
    const page: any = {
      click: async (x: number, y: number) => void calls.push([x, y]),
    };
    await dispatchTrustedClick(page, { frame: null } as any, 5, 6);
    expect(calls).toEqual([[5, 6]]);
  });
});
