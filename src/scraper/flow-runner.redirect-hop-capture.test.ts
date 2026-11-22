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
      redirectHasExtraInfo: false,
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

  it("credits same-site POSTs to the signal counter but not cross-site or GET", async () => {
    const handlers = new Map<string, (p: unknown) => void | Promise<void>>();
    const session = {
      on: (e: string, h: (p: unknown) => void | Promise<void>) => handlers.set(e, h),
      off: () => {},
    };
    const page = {
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP: vi.fn(async () => ({ body: "{}", base64Encoded: false })),
    } as unknown as Page;
    const signalCounter = { n: 0 };
    const teardown = wireSignalCapture(page, {
      counter: { n: 0 },
      signalCounter,
      recentCaptures: [],
      recentCaptureMeta: [],
      getCurrentPhase: () => "action",
      getCurrentPageOrigin: () => "https://www.example.com",
      onCapture: () => {},
    });
    const send = async (id: string, url: string, method: string) => {
      handlers.get("Network.requestWillBeSent")?.({
        requestId: id,
        request: { url, method, headers: {}, postData: method === "GET" ? undefined : "x=1" },
      });
      await handlers.get("Network.loadingFinished")?.({ requestId: id });
      await new Promise((r) => setTimeout(r, 0));
    };
    await send("a", "https://api.example.com/s", "POST"); // sibling subdomain: counts
    expect(signalCounter.n).toBe(1);
    await send("b", "https://tracker.other.net/p", "POST"); // cross-site: no
    await send("c", "https://www.example.com/g", "GET"); // GET: no
    expect(signalCounter.n).toBe(1);
    teardown();
  });
});

function harness(pageOrigin = "https://example.com") {
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
  const signalCounter = { n: 0 };
  const teardown = wireSignalCapture(page, {
    counter: { n: 0 },
    signalCounter,
    recentCaptures: [],
    recentCaptureMeta: [],
    getCurrentPhase: () => "action",
    getCurrentPageOrigin: () => pageOrigin,
    onCapture: (c) => captured.push(c),
  });
  const fire = (e: string, p: unknown) => handlers.get(e)?.(p);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { fire, flush, captured, signalCounter, sendCDP, teardown };
}

describe("redirect hop capture: additional regressions", () => {
  it("records the hop's Set-Cookie and Location without fetching a hop body", async () => {
    const t = harness();
    t.fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/a", method: "POST", headers: {}, postData: "x=1" },
    });
    t.fire("Network.responseReceivedExtraInfo", {
      requestId: "r1",
      headers: { "Set-Cookie": "sid=abc" },
    });
    t.fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/b", method: "GET", headers: {} },
      redirectResponse: { status: 303, headers: { Location: "/b" } },
    });
    await t.fire("Network.loadingFinished", { requestId: "r1" });
    await t.flush();
    t.teardown();
    const post = t.captured.find((c) => c.method === "POST");
    expect(post?.status).toBe(303);
    expect(post?.requestPostData).toBe("x=1");
    expect(post?.responseHeaders.Location).toBe("/b");
    expect(JSON.stringify(post?.responseHeaders)).toContain("sid=abc");
    // one getResponseBody only: for the final GET, none for the redirect hop
    expect(t.sendCDP.mock.calls.filter((c) => c[0] === "Network.getResponseBody")).toHaveLength(1);
  });

  it("keeps hop attribution when the next hop's extra-info precedes its requestWillBeSent", async () => {
    const t = harness();
    t.fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/a", method: "POST", headers: {}, postData: "x=1" },
    });
    t.fire("Network.responseReceivedExtraInfo", {
      requestId: "r1",
      headers: { "Set-Cookie": "s0" },
    });
    // hop 1 extra-info arrives BEFORE the redirect's requestWillBeSent
    t.fire("Network.responseReceivedExtraInfo", {
      requestId: "r1",
      headers: { "Set-Cookie": "s1" },
    });
    t.fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/b", method: "GET", headers: {} },
      redirectResponse: { status: 302, headers: { Location: "/b" } },
    });
    await t.fire("Network.loadingFinished", { requestId: "r1" });
    await t.flush();
    t.teardown();
    const post = t.captured.find((c) => c.method === "POST");
    const get = t.captured.find((c) => c.method === "GET");
    expect(JSON.stringify(post?.responseHeaders)).toContain("s0");
    expect(JSON.stringify(post?.responseHeaders)).not.toContain("s1");
    expect(JSON.stringify(get?.responseHeaders)).toContain("s1");
    expect(JSON.stringify(get?.responseHeaders)).not.toContain("s0");
  });

  it("emits one capture per hop for a redirect chain", async () => {
    const t = harness();
    t.fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/a", method: "POST", headers: {}, postData: "x=1" },
    });
    t.fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/b", method: "GET", headers: {} },
      redirectResponse: { status: 302, headers: { Location: "/b" } },
      redirectHasExtraInfo: false,
    });
    t.fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/c", method: "GET", headers: {} },
      redirectResponse: { status: 301, headers: { Location: "/c" } },
      redirectHasExtraInfo: false,
    });
    await t.fire("Network.loadingFinished", { requestId: "r1" });
    await t.flush();
    t.teardown();
    expect(t.captured).toHaveLength(3);
    expect(t.captured.map((c) => c.url).sort()).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
    expect(t.captured.find((c) => c.url.endsWith("/b"))?.status).toBe(301);
  });

  it("counts a redirected POST hop toward the signal counter", async () => {
    const t = harness();
    t.fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/a", method: "POST", headers: {}, postData: "x=1" },
    });
    t.fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/b", method: "GET", headers: {} },
      redirectResponse: { status: 302, headers: {} },
      redirectHasExtraInfo: false,
    });
    // POST hop is finalized on the redirect itself, before loadingFinished
    await t.flush();
    expect(t.signalCounter.n).toBe(1);
    await t.fire("Network.loadingFinished", { requestId: "r1" });
    await t.flush();
    t.teardown();
    expect(t.signalCounter.n).toBe(1); // final GET adds nothing
  });

  it("does not credit a redirected third-party POST hop", async () => {
    const t = harness();
    t.fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://tracker.other.net/p", method: "POST", headers: {}, postData: "x=1" },
    });
    t.fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://tracker.other.net/q", method: "GET", headers: {} },
      redirectResponse: { status: 302, headers: {} },
    });
    await t.fire("Network.loadingFinished", { requestId: "r1" });
    await t.flush();
    t.teardown();
    expect(t.signalCounter.n).toBe(0);
  });

  it.each([
    [302, "POST"],
    [303, "POST"],
    [302, "PUT"],
  ])(
    "keeps a Set-Cookie arriving just after a %i redirect on the %s capture",
    async (status, method) => {
      const t = harness();
      t.fire("Network.requestWillBeSent", {
        requestId: "r1",
        request: { url: "https://example.com/a", method, headers: {}, postData: "x=1" },
      });
      // no headers on the redirectResponse; extra-info not yet declared absent
      t.fire("Network.requestWillBeSent", {
        requestId: "r1",
        request: { url: "https://example.com/b", method: "GET", headers: {} },
        redirectResponse: { status },
      });
      t.fire("Network.responseReceivedExtraInfo", {
        requestId: "r1",
        headers: { "Set-Cookie": "late=1" },
      });
      await t.fire("Network.loadingFinished", { requestId: "r1" });
      await t.flush();
      t.teardown();
      const cap = t.captured.find((c) => c.method === method);
      expect(typeof cap?.responseHeaders).toBe("object");
      expect(JSON.stringify(cap?.responseHeaders)).toContain("late=1");
    }
  );
});

describe("redirect hop capture: deferred state drop", () => {
  it("keeps hop state after loadingFinished until the pending hop's extra-info lands", async () => {
    const t = harness();
    t.fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/a", method: "POST", headers: {}, postData: "x=1" },
    });
    t.fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/b", method: "GET", headers: {} },
      redirectResponse: { status: 302, headers: { Location: "/b" } },
    });
    // final hop finishes while the redirect hop still waits for its extra-info
    await t.fire("Network.loadingFinished", { requestId: "r1" });
    expect(t.captured.some((c) => c.method === "POST")).toBe(false);
    // hop 0's extra-info arrives only now; its buffer must not have been dropped
    t.fire("Network.responseReceivedExtraInfo", {
      requestId: "r1",
      headers: { "Set-Cookie": "late0" },
    });
    await t.flush();
    const post = t.captured.find((c) => c.method === "POST");
    const get = t.captured.find((c) => c.method === "GET");
    expect(JSON.stringify(post?.responseHeaders)).toContain("late0");
    expect(JSON.stringify(get?.responseHeaders ?? {})).not.toContain("late0");
    // after the last pending hop completes, the id's state is dropped: a fresh
    // request reusing the id starts at hop 0 and receives its own extra-info.
    t.fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/c", method: "GET", headers: {} },
    });
    t.fire("Network.responseReceivedExtraInfo", {
      requestId: "r1",
      headers: { "Set-Cookie": "fresh" },
    });
    await t.fire("Network.loadingFinished", { requestId: "r1" });
    await t.flush();
    t.teardown();
    const fresh = t.captured.find((c) => c.url.endsWith("/c"));
    expect(JSON.stringify(fresh?.responseHeaders)).toContain("fresh");
    expect(JSON.stringify(fresh?.responseHeaders)).not.toContain("late0");
  });
});
