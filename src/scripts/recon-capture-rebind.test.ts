import { describe, expect, it, vi } from "vitest";
import { createCaptureRebinder } from "@/scripts/recon-capture-rebind";

describe("createCaptureRebinder", () => {
  it("rewires capture on adopted page, exposes it, and stops all listeners", () => {
    const stops: ReturnType<typeof vi.fn>[] = [];
    const wire = vi.fn((_p: string) => {
      const s = vi.fn();
      stops.push(s);
      return s;
    });
    const r = createCaptureRebinder<string>("a", wire);
    expect(r.current()).toBe("a");
    r.adopt("b");
    r.adopt("b");
    expect(r.current()).toBe("b");
    expect(wire).toHaveBeenCalledTimes(2);
    r.stopAll();
    for (const s of stops) expect(s).toHaveBeenCalledTimes(1);
  });
});
