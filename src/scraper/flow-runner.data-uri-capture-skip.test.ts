import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { wireSignalCapture } from "@/scraper/flow-runner";
import type { Capture } from "@/scripts/recon-shared";

function fakeCapturePage(): {
  page: Page;
  emit: (event: string, params: unknown) => void | Promise<void>;
} {
  const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
  const session = {
    on: (event: string, handler: (params: unknown) => void | Promise<void>) => {
      handlers.set(event, handler);
    },
    off: () => {},
  };
  const page = {
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
  return { page, emit: (e, p) => handlers.get(e)?.(p) };
}

describe("flow-runner/wireSignalCapture — non-http(s) URLs are not captured", () => {
  it("skips data: and blob: requests, captures https, counter stays contiguous", async () => {
    const { page, emit } = fakeCapturePage();
    const captured: Capture[] = [];
    const counter = { n: 0 };
    const recentCaptures: string[] = [];
    const teardown = wireSignalCapture(page, {
      counter,
      signalCounter: { n: 0 },
      recentCaptures,
      recentCaptureMeta: [],
      getCurrentPhase: () => "action",
      getCurrentPageOrigin: () => "https://example.com",
      onCapture: (c) => captured.push(c),
    });
    const urls = [
      "data:image/svg+xml;base64,PHN2ZyBm",
      "blob:https://example.com/abc-123",
      "https://example.com/api/submit",
    ];
    for (const [i, url] of urls.entries()) {
      emit("Network.requestWillBeSent", {
        requestId: `r${i}`,
        request: { url, method: "POST", headers: {}, postData: "{}" },
      });
      await emit("Network.loadingFinished", { requestId: `r${i}` });
    }
    teardown();
    expect(captured.map((c) => c.url)).toEqual(["https://example.com/api/submit"]);
    expect(counter.n).toBe(1);
    expect(recentCaptures).toHaveLength(1);
  });
});
