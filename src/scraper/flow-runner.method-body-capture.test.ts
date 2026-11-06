import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { REQUEST_BODY_UNAVAILABLE, wireSignalCapture } from "@/scraper/flow-runner";
import type { Capture } from "@/scripts/recon-shared";

async function run(
  method: string,
  hasPostData: boolean | undefined,
  postDataCalls: Array<string | null>
): Promise<Capture> {
  const handlers = new Map<string, (p: unknown) => void | Promise<void>>();
  const session = { on: (e: string, h: (p: unknown) => void | Promise<void>) => handlers.set(e, h), off: () => {} };
  const queue = [...postDataCalls];
  const page = {
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: vi.fn(async (name: string) => {
      if (name === "Network.getRequestPostData") {
        const v = queue.shift() ?? null;
        if (v === null) throw new Error("no data");
        return { postData: v };
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
  const request: Record<string, unknown> = { url: "https://api.example.com/x", method, headers: {} };
  if (hasPostData !== undefined) request.hasPostData = hasPostData;
  handlers.get("Network.requestWillBeSent")?.({ requestId: "r1", request });
  await handlers.get("Network.loadingFinished")?.({ requestId: "r1" });
  teardown();
  if (!captured[0]) throw new Error("no capture");
  return captured[0];
}

describe("method-based request body capture", () => {
  for (const method of ["POST", "PUT", "PATCH", "post", "patch"]) {
    for (const flag of [false, undefined]) {
      it(`${method} hasPostData=${flag} records body at request time`, async () => {
        expect((await run(method, flag, ['{"a":1}'])).requestPostData).toBe('{"a":1}');
      });
      it(`${method} hasPostData=${flag} recovers body only at loadingFinished`, async () => {
        expect((await run(method, flag, [null, '{"a":2}'])).requestPostData).toBe('{"a":2}');
      });
      it(`${method} hasPostData=${flag} records marker, not null`, async () => {
        expect((await run(method, flag, [])).requestPostData).toBe(REQUEST_BODY_UNAVAILABLE);
      });
    }
  }
  it("DELETE hasPostData=true recovers body", async () => {
    expect((await run("DELETE", true, ['{"d":1}'])).requestPostData).toBe('{"d":1}');
  });
  it("DELETE hasPostData=true with nothing gets marker", async () => {
    expect((await run("DELETE", true, [])).requestPostData).toBe(REQUEST_BODY_UNAVAILABLE);
  });
  it("bodyless GET stays null", async () => {
    expect((await run("GET", false, ['{"x":1}'])).requestPostData).toBeNull();
  });
});
