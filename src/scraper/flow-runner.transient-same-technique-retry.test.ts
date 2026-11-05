import type { Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import { guardedAct } from "@/scraper/stagehand-guard";

const OK = { success: true, message: "ok", actionDescription: "clicked", actions: [] };
const BLIP = {
  success: false,
  message: "500 Internal Server Error",
  actionDescription: "",
  actions: [],
};

describe("act retries a transient provider error on the same technique", () => {
  it("retries a resolved transient failure envelope and succeeds", async () => {
    const act = vi.fn().mockResolvedValueOnce(BLIP).mockResolvedValueOnce(OK);
    const r = await guardedAct(
      { act } as unknown as Stagehand,
      "click 'Next'",
      undefined,
      undefined,
      undefined,
      true
    );
    expect(r.success).toBe(true);
    expect(act).toHaveBeenCalledTimes(2);
  });
  it("does not retry a non-transient failure envelope", async () => {
    const fail = { ...BLIP, message: "no candidates" };
    const act = vi.fn().mockResolvedValue(fail);
    const r = await guardedAct(
      { act } as unknown as Stagehand,
      "click 'Next'",
      undefined,
      undefined,
      undefined,
      true
    );
    expect(r.success).toBe(false);
    expect(act).toHaveBeenCalledTimes(1);
  });
});
