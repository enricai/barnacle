import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { attachToSurfacedInput } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const fixture = { buffer: Buffer.from("pdf"), name: "resume.pdf", mimeType: "application/pdf" };

async function run(textSeq: boolean[]): Promise<boolean> {
  let i = 0;
  const target = {
    locator: () => ({ first: () => ({ setInputFiles: vi.fn(async () => undefined) }) }),
    evaluate: vi.fn(async (expr: string) => {
      if (expr.includes("innerText")) return textSeq[Math.min(i++, textSeq.length - 1)];
      if (expr.includes("files.length) return")) return 0;
      return false;
    }),
  };
  {
    const r = attachToSurfacedInput({
      page: { waitForTimeout: vi.fn(() => new Promise<void>((r) => setTimeout(r, 200))) } as unknown as Page,
      target: target as never,
      fixture,
      logger,
      signalCounter: { n: 0 },
      recentCaptureMeta: [],
    });
    return await r;
  }
}

describe("attachToSurfacedInput consumed input", () => {
  it("succeeds when the name newly appears and files are cleared", async () => {
    expect(await run([false, true])).toBe(true);
  });
  it("is not success when the name was already present", async () => {
    expect(await run([true, true])).toBe(false);
  }, 30000);
  it("is not success when the name never appears", async () => {
    expect(await run([false, false])).toBe(false);
  }, 30000);
});
