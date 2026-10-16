import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { waitForUploadNetworkSignal } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const fixture = { buffer: Buffer.from("pdf"), name: "resume.pdf", mimeType: "application/pdf" };

type Meta = { method: string; status: number; url: string; hasBody?: boolean; multipart?: boolean };

async function run(capture: Meta): Promise<boolean> {
  const signalCounter = { n: 0 };
  const recentCaptureMeta: Meta[] = [];
  const page = {
    waitForTimeout: vi.fn(async () => {
      signalCounter.n = 1;
      recentCaptureMeta.push(capture);
    }),
  } as unknown as Page;
  vi.useFakeTimers();
  try {
    const result = waitForUploadNetworkSignal({
      page,
      fixture,
      logger,
      signalCounter,
      recentCaptureMeta,
      stopWhen: () => signalCounter.n === 1,
    });
    await vi.runAllTimersAsync();
    return await result;
  } finally {
    vi.useRealTimers();
  }
}

describe("waitForUploadNetworkSignal", () => {
  it("rejects a URL-matching POST with no body", async () => {
    expect(
      await run({ method: "POST", status: 200, url: "https://a.example.com/attachments" })
    ).toBe(false);
  });

  it("rejects a non-upload POST even with a body", async () => {
    expect(
      await run({
        method: "POST",
        status: 200,
        url: "https://a.example.com/interruption_check",
        hasBody: true,
      })
    ).toBe(false);
  });

  it("accepts a URL-matching POST with a body", async () => {
    expect(
      await run({
        method: "POST",
        status: 200,
        url: "https://a.example.com/attachments",
        hasBody: true,
      })
    ).toBe(true);
  });

  it("accepts a multipart POST whose body CDP omitted", async () => {
    expect(
      await run({ method: "POST", status: 200, url: "https://a.example.com/x", multipart: true })
    ).toBe(true);
  });
});
