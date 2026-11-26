import { describe, expect, it, vi } from "vitest";
import { CardStepError, executeCardStep } from "@/scraper/card-step";

function fakeTarget(url: string, opts: { focused?: boolean; complete?: boolean; frame?: boolean }) {
  const type = vi.fn(async () => {});
  const field = { click: vi.fn(async () => {}), type };
  return {
    type,
    target: {
      frame: opts.frame === false ? null : {},
      url: async () => url,
      locator: () => ({ first: () => field }),
      evaluate: async (expr: string) =>
        expr.includes("activeElement") ? (opts.focused ?? true) : (opts.complete ?? true),
    } as never,
  };
}
const page = { url: () => "https://shop.example/" } as never;
const spec = { value: "4242", frameOrigin: "https://pay.example", completeSelector: ".ok" };

describe("executeCardStep", () => {
  it("types in the provider frame when focus and completeness hold", async () => {
    const f = fakeTarget("https://pay.example/f", {});
    await executeCardStep({ page, target: f.target, spec });
    expect(f.type).toHaveBeenCalledWith("4242", expect.anything());
  });
  it.each([
    ["wrong origin", { url: "https://evil.example/f" }, "wrong-frame"],
    ["main-frame fallback", { frame: false }, "wrong-frame"],
    ["unfocused", { focused: false }, "not-focused"],
    ["incomplete", { complete: false }, "incomplete"],
  ])("fails closed: %s", async (_n, o, reason) => {
    const { url, ...rest } = o as { url?: string };
    const f = fakeTarget(url ?? "https://pay.example/f", rest);
    await expect(executeCardStep({ page, target: f.target, spec })).rejects.toMatchObject({
      reason,
    });
  });
  it("rejects an absent value without typing", async () => {
    const f = fakeTarget("https://pay.example/f", {});
    await expect(
      executeCardStep({ page, target: f.target, spec: { ...spec, value: undefined } })
    ).rejects.toBeInstanceOf(CardStepError);
    expect(f.type).not.toHaveBeenCalled();
  });
});
