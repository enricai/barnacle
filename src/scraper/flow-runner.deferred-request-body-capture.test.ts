import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { REQUEST_BODY_UNAVAILABLE, wireSignalCapture } from "@/scraper/flow-runner";
import type { Capture } from "@/scripts/recon-shared";

type Req = { method: string; postData?: string; hasPostData?: boolean };

async function capture(
  req: Req,
  getPostData: () => Promise<unknown>
): Promise<{ cap: Capture; sendCDP: ReturnType<typeof vi.fn> }> {
  const handlers = new Map<string, (p: unknown) => void | Promise<void>>();
  const session = {
    on: (e: string, h: (p: unknown) => void | Promise<void>) => void handlers.set(e, h),
    off: () => {},
  };
  const sendCDP = vi.fn(async (method: string) =>
    method === "Network.getRequestPostData" ? getPostData() : { body: "{}", base64Encoded: false }
  );
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
    getCurrentPageOrigin: () => "https://api.example.com",
    onCapture: (c) => captured.push(c),
  });
  handlers.get("Network.requestWillBeSent")?.({
    requestId: "r1",
    request: { url: "https://api.example.com/items/1", headers: {}, ...req },
  });
  await handlers.get("Network.loadingFinished")?.({ requestId: "r1" });
  teardown();
  const cap = captured[0];
  if (!cap) throw new Error("no capture emitted");
  return { cap, sendCDP };
}

describe("flow-runner/wireSignalCapture — deferred request bodies", () => {
  it("fetches a deferred PUT body via Network.getRequestPostData and decodes it", async () => {
    const body = JSON.stringify({ operationName: "Save", query: "mutation Save { s }" });
    const { cap } = await capture({ method: "PUT", hasPostData: true }, async () => ({
      postData: body,
    }));
    expect(cap.requestPostData).toBe(body);
    expect(cap.decodedParams).toEqual({ operationName: "Save", query: "mutation Save { s }" });
    expect(cap.operationName).toBe("Save");
  });

  it("records the explicit marker (not null) when the fetch rejects", async () => {
    const { cap } = await capture({ method: "PUT", hasPostData: true }, async () => {
      throw new Error("No resource with given identifier");
    });
    expect(cap.requestPostData).toBe(REQUEST_BODY_UNAVAILABLE);
    expect(REQUEST_BODY_UNAVAILABLE).toBe("<unavailable>");
    expect(cap.decodedParams).toBeNull();
  });

  it("leaves inline-postData captures unchanged without fetching", async () => {
    const { cap, sendCDP } = await capture(
      { method: "POST", postData: '{"a":1}', hasPostData: true },
      async () => ({ postData: "wrong" })
    );
    expect(cap.requestPostData).toBe('{"a":1}');
    expect(sendCDP).not.toHaveBeenCalledWith("Network.getRequestPostData", expect.anything());
  });

  it("leaves bodiless GET captures null without fetching", async () => {
    const { cap, sendCDP } = await capture({ method: "GET" }, async () => ({ postData: "x" }));
    expect(cap.requestPostData).toBeNull();
    expect(sendCDP).not.toHaveBeenCalledWith("Network.getRequestPostData", expect.anything());
  });
});

describe("flow-runner/wireSignalCapture — request-time body capture", () => {
  it("recovers a PUT body when hasPostData is omitted", async () => {
    const { cap } = await capture({ method: "PUT" }, async () => ({ postData: '{"a":2}' }));
    expect(cap.requestPostData).toBe('{"a":2}');
  });
  it.each(["PUT", "PATCH", "POST", "put"])(
    "records the marker for %s with hasPostData omitted when the body fetch rejects",
    async (method) => {
      const { cap } = await capture({ method }, async () => {
        throw new Error("No resource with given identifier");
      });
      expect(cap.requestPostData).toBe(REQUEST_BODY_UNAVAILABLE);
      expect(cap.decodedParams).toBeNull();
    }
  );
  it("records the marker for a PUT with hasPostData omitted when the fetch returns nothing", async () => {
    const { cap } = await capture({ method: "PUT" }, async () => ({ postData: "" }));
    expect(cap.requestPostData).toBe(REQUEST_BODY_UNAVAILABLE);
  });
  it("keeps a bodyless DELETE with hasPostData omitted as null", async () => {
    const { cap } = await capture({ method: "DELETE" }, async () => ({ postData: "" }));
    expect(cap.requestPostData).toBeNull();
  });
  it("keeps inline postData verbatim when hasPostData is omitted", async () => {
    const { cap } = await capture({ method: "PUT", postData: "BODY" }, async () => ({
      postData: "other",
    }));
    expect(cap.requestPostData).toBe("BODY");
  });
});
