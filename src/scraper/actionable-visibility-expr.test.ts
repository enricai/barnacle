import { afterEach, describe, expect, it } from "vitest";

import { ACTIONABLE_VISIBILITY_EXPR } from "@/scraper/actionable-visibility-expr";

interface FakeOpts {
  attrs?: Record<string, string>;
  width?: number;
  height?: number;
  display?: string;
  visibility?: string;
}

function fake(opts: FakeOpts = {}): unknown {
  const attrs = opts.attrs ?? {};
  return {
    getAttribute: (n: string): string | null => attrs[n] ?? null,
    getBoundingClientRect: (): { width: number; height: number } => ({
      width: opts.width ?? 10,
      height: opts.height ?? 10,
    }),
    style: { display: opts.display ?? "block", visibility: opts.visibility ?? "visible" },
  };
}

const g = globalThis as unknown as { getComputedStyle?: unknown };

function check(opts: FakeOpts): boolean {
  g.getComputedStyle = (el: { style: unknown }): unknown => el.style;
  const fn = new Function(`return (${ACTIONABLE_VISIBILITY_EXPR});`)() as (el: unknown) => boolean;
  return fn(fake(opts));
}

describe("ACTIONABLE_VISIBILITY_EXPR", () => {
  afterEach(() => {
    delete g.getComputedStyle;
  });

  it("accepts a visible element", () => {
    expect(check({})).toBe(true);
  });
  it("rejects aria-hidden=true decoys sharing visible text", () => {
    expect(check({ attrs: { "aria-hidden": "true" } })).toBe(false);
  });
  it("rejects 0x0, display:none and visibility:hidden", () => {
    expect(check({ width: 0, height: 0 })).toBe(false);
    expect(check({ display: "none" })).toBe(false);
    expect(check({ visibility: "hidden" })).toBe(false);
  });
  it("accepts aria-hidden=false and tabindex=-1 without aria-hidden", () => {
    expect(check({ attrs: { "aria-hidden": "false" } })).toBe(true);
    expect(check({ attrs: { tabindex: "-1" } })).toBe(true);
  });
});
