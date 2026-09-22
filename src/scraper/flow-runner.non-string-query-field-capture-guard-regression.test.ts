import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { wireSignalCapture } from "@/scraper/flow-runner";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Fake CDP session mirroring the harness in flow-runner.test.ts — records the
 * handlers `wireSignalCapture` registers so a test can fire Network events
 * without a real browser.
 */
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
  const emit = (event: string, params: unknown): void | Promise<void> =>
    handlers.get(event)?.(params);
  return { page, emit };
}

describe("flow-runner/wireSignalCapture — Capture.query stays string-typed", () => {
  const REQ_URL = "https://api.example.com/graphql";

  async function captureWithPostData(postData: string): Promise<Capture> {
    const { page, emit } = fakeCapturePage();
    const captured: Capture[] = [];
    const teardown = wireSignalCapture(page, {
      counter: { n: 0 },
      signalCounter: { n: 0 },
      recentCaptures: [],
      recentCaptureMeta: [],
      getCurrentPhase: () => "action",
      getCurrentPageOrigin: () => "https://api.example.com",
      onCapture: (capture) => captured.push(capture),
    });
    emit("Network.requestWillBeSent", {
      requestId: "req-query-guard",
      request: { url: REQ_URL, method: "POST", headers: {}, postData },
    });
    await emit("Network.loadingFinished", { requestId: "req-query-guard" });
    teardown();
    const cap = captured[0];
    if (!cap) throw new Error("no capture emitted");
    return cap;
  }

  it("nulls query when the decoded body's query key holds a nested object, never the raw object", async () => {
    const cap = await captureWithPostData(
      JSON.stringify({ query: { identity: { fetch: ["a", "b"] } } })
    );
    expect(cap.query).toBeNull();
  });

  it("passes a genuine GraphQL query string through unchanged", async () => {
    const cap = await captureWithPostData(
      JSON.stringify({ query: "query Identity { identity { fetch } }" })
    );
    expect(cap.query).toBe("query Identity { identity { fetch } }");
  });
});
