/** 401 replays are retried once with the captured authorization (replay-safe requests only). */
import { afterEach, describe, expect, it, vi } from "vitest";

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({
  getLogger: () => loggerStub,
  getScriptLogger: () => loggerStub,
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));

import { replayCapture } from "@/scripts/recon-http";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = `eyJ${b64({ alg: "none" }).slice(3)}.eyJ${b64({ sub: "u1" }).slice(3)}.sig`;

function stub(okWithAuth: boolean) {
  const seen: Array<Record<string, string>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string | URL, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      seen.push(h);
      const ok = okWithAuth && h.authorization !== undefined;
      return new Response(JSON.stringify(ok ? { a: 1 } : {}), {
        status: ok ? 200 : 401,
        headers: { "content-type": "application/json" },
      });
    })
  );
  return seen;
}

const cap = (method: string, extra: object = {}) =>
  ({
    method,
    url: "https://x.test/api",
    requestHeaders: { authorization: `Bearer ${JWT}`, "x-other": "1" },
    responseBody: { a: 1 },
    operationName: null,
    ...extra,
  }) as never;

describe("recon-http 401 auth replay", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries with captured authorization and reports token source", async () => {
    const seen = stub(true);
    const r = await replayCapture("a.json", cap("GET"), {
      htmlDocuments: ["<html></html>", `<script>var t="${JWT}"</script>`],
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.authorization).toBe(`Bearer ${JWT}`);
    expect(r?.authReplay).toMatchObject({
      status: 200,
      tokenReplayable: true,
      tokenSource: { document: 1, source: "html" },
    });
    expect(r?.omittedCaptureHeaders).toEqual(["x-other"]);
  });

  it("records needs-browser when the retry also fails", async () => {
    stub(false);
    const r = await replayCapture("a.json", cap("GET"));
    expect(r?.authReplay?.tokenReplayable).toBe(false);
  });

  it("does not retry unsafe requests or non-401 flows", async () => {
    const seen = stub(true);
    const r = await replayCapture("a.json", cap("POST"));
    expect(seen).toHaveLength(1);
    expect(r?.authReplay).toBeUndefined();
    expect(r?.omittedCaptureHeaders).toContain("authorization");
  });

  it("first attempt omits authorization; replayable without HTML leaves tokenSource null", async () => {
    const seen = stub(true);
    const r = await replayCapture("a.json", cap("GET"));
    expect(seen[0]!.authorization).toBeUndefined();
    expect(seen[1]!.authorization).toBe(`Bearer ${JWT}`);
    expect(r?.authReplay).toMatchObject({ status: 200, tokenReplayable: true, tokenSource: null });
  });
});
