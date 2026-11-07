import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { REQUEST_BODY_UNAVAILABLE, wireSignalCapture } from "@/scraper/flow-runner";
import type { Capture } from "@/scripts/recon-shared";

const b64 = (bytes: Buffer | string): string => Buffer.from(bytes).toString("base64");

async function run(
  method: string,
  request: Record<string, unknown>,
  lazyReply: Record<string, unknown> | null
): Promise<Capture> {
  const handlers = new Map<string, (p: unknown) => void | Promise<void>>();
  const session = {
    on: (e: string, h: (p: unknown) => void | Promise<void>) => handlers.set(e, h),
    off: () => {},
  };
  const page = {
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: vi.fn(async (name: string) => {
      if (name === "Network.getRequestPostData") {
        if (lazyReply === null) throw new Error("no data");
        return lazyReply;
      }
      return { body: "{}", base64Encoded: false };
    }),
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
    request: { url: "https://api.example.com/x", method, headers: {}, ...request },
  });
  await handlers.get("Network.loadingFinished")?.({ requestId: "r1" });
  teardown();
  if (!captured[0]) throw new Error("no capture");
  return captured[0];
}

describe("encoded request body capture", () => {
  const json = '{"name":"Zoë","n":1}';

  for (const method of ["POST", "PUT", "PATCH"]) {
    it(`${method} lazy body returned base64-encoded is recorded decoded`, async () => {
      const c = await run(
        method,
        { hasPostData: true },
        { postData: b64(json), base64Encoded: true }
      );
      expect(c.requestPostData).toBe(json);
      expect(c.decodedParams).toEqual({ name: "Zoë", n: 1 });
    });

    it(`${method} lazy body flagged not base64 is recorded as-is`, async () => {
      const c = await run(method, { hasPostData: true }, { postData: json, base64Encoded: false });
      expect(c.requestPostData).toBe(json);
    });

    it(`${method} body delivered only as postDataEntries is recorded decoded`, async () => {
      const c = await run(
        method,
        { hasPostData: true, postDataEntries: [{ bytes: b64(json) }] },
        null
      );
      expect(c.requestPostData).toBe(json);
    });

    it(`${method} multi-chunk postDataEntries are joined before decoding`, async () => {
      // Split inside the two-byte "ë" so only the joined bytes are valid UTF-8.
      const bytes = Buffer.from(json);
      const cut = bytes.indexOf(0xc3) + 1;
      const c = await run(
        method,
        {
          hasPostData: true,
          postDataEntries: [
            { bytes: b64(bytes.subarray(0, cut)) },
            { bytes: b64(bytes.subarray(cut)) },
          ],
        },
        null
      );
      expect(c.requestPostData).toBe(json);
    });
  }

  it("non-UTF-8 binary body is marked unavailable, never raw base64", async () => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    const lazy = await run(
      "PUT",
      { hasPostData: true },
      { postData: b64(binary), base64Encoded: true }
    );
    expect(lazy.requestPostData).toBe(REQUEST_BODY_UNAVAILABLE);
    const entries = await run("PUT", { postDataEntries: [{ bytes: b64(binary) }] }, null);
    expect(entries.requestPostData).toBe(REQUEST_BODY_UNAVAILABLE);
  });

  it("postDataEntries without bytes (a file part) falls back to the lazy fetch", async () => {
    const c = await run(
      "PATCH",
      { hasPostData: true, postDataEntries: [{}] },
      { postData: json, base64Encoded: false }
    );
    expect(c.requestPostData).toBe(json);
  });
});
