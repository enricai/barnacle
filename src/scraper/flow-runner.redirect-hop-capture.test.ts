import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { wireSignalCapture } from "@/scraper/flow-runner";
import type { Capture } from "@/scripts/recon-shared";

describe("redirect hop capture", () => {
  it("captures a redirected POST hop and the final GET separately", async () => {
    const handlers = new Map<string, (p: unknown) => void | Promise<void>>();
    const session = {
      on: (e: string, h: (p: unknown) => void | Promise<void>) => handlers.set(e, h),
      off: () => {},
    };
    const sendCDP = vi.fn(async (name: string) => {
      if (name === "Network.getResponseBody") return { body: "{}", base64Encoded: false };
      throw new Error("n/a");
    });
    const page = {
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP,
    } as unknown as Page;
    const captured: Capture[] = [];
    const teardown = wireSignalCapture(page, {
      counter: { n: 0 },
      signalCounter: { n: 0 },
      recentCaptures: [],
      recentCaptureMeta: [],
      getCurrentPhase: () => "action",
      getCurrentPageOrigin: () => "https://example.com",
      onCapture: (c) => captured.push(c),
    });
    handlers.get("Network.requestWillBeSent")?.({
      requestId: "r1",
      request: { url: "https://example.com/a", method: "POST", headers: {}, postData: "x=1" },
    });
    handlers.get("Network.requestWillBeSent")?.({
      requestId: "r1",
      request: { url: "https://example.com/b", method: "GET", headers: {} },
      redirectResponse: { status: 302, headers: { Location: "https://example.com/b" } },
    });
    await handlers.get("Network.loadingFinished")?.({ requestId: "r1" });
    await new Promise((r) => setTimeout(r, 0));
    teardown();
    expect(captured).toHaveLength(2);
    const hop = captured.find((c) => c.method === "POST");
    expect(hop?.status).toBe(302);
    expect(hop?.requestPostData).toBe("x=1");
    expect(hop?.responseHeaders.Location).toBe("https://example.com/b");
    expect(captured.some((c) => c.method === "GET")).toBe(true);
    expect(sendCDP).toHaveBeenCalledTimes(1);
  });

  it("attributes extra-info headers to the hop they arrived for", async () => {
    const handlers = new Map<string, (p: unknown) => void | Promise<void>>();
    const session = {
      on: (e: string, h: (p: unknown) => void | Promise<void>) => handlers.set(e, h),
      off: () => {},
    };
    const page = {
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP: vi.fn(async (name: string) => {
        if (name === "Network.getResponseBody") return { body: "{}", base64Encoded: false };
        throw new Error("n/a");
      }),
    } as unknown as Page;
    const captured: Capture[] = [];
    const teardown = wireSignalCapture(page, {
      counter: { n: 0 },
      signalCounter: { n: 0 },
      recentCaptures: [],
      recentCaptureMeta: [],
      getCurrentPhase: () => "action",
      getCurrentPageOrigin: () => "https://example.com",
      onCapture: (c) => captured.push(c),
    });
    const h = (e: string) => handlers.get(e);
    h("Network.requestWillBeSent")?.({
      requestId: "r1",
      request: { url: "https://example.com/a", method: "POST", headers: {}, postData: "x=1" },
    });
    h("Network.requestWillBeSentExtraInfo")?.({ requestId: "r1", headers: { Cookie: "hop0" } });
    h("Network.responseReceivedExtraInfo")?.({ requestId: "r1", headers: { "Set-Cookie": "s0" } });
    h("Network.requestWillBeSent")?.({
      requestId: "r1",
      request: { url: "https://example.com/b", method: "GET", headers: {} },
      redirectResponse: { status: 302, headers: { Location: "/b" } },
    });
    h("Network.requestWillBeSentExtraInfo")?.({ requestId: "r1", headers: { Cookie: "hop1" } });
    h("Network.responseReceivedExtraInfo")?.({ requestId: "r1", headers: { "Set-Cookie": "s1" } });
    await h("Network.loadingFinished")?.({ requestId: "r1" });
    await new Promise((r) => setTimeout(r, 0));
    teardown();
    const post = captured.find((c) => c.method === "POST");
    const get = captured.find((c) => c.method === "GET");
    expect(JSON.stringify(post?.requestHeaders)).toContain("hop0");
    expect(JSON.stringify(post?.requestHeaders)).not.toContain("hop1");
    expect(JSON.stringify(post?.responseHeaders)).toContain("s0");
    expect(JSON.stringify(get?.requestHeaders)).toContain("hop1");
    expect(JSON.stringify(get?.requestHeaders)).not.toContain("hop0");
    expect(JSON.stringify(get?.responseHeaders)).toContain("s1");
    expect(JSON.stringify(get?.responseHeaders)).not.toContain("s0");
  });
});
