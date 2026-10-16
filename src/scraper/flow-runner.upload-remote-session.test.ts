import { afterEach, describe, expect, it, vi } from "vitest";

import { setFilesViaCdp } from "@/scraper/flow-runner";

const fixture = { buffer: Buffer.from("hello"), name: "resume.pdf", mimeType: "application/pdf" };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function makeParams(extra: Record<string, unknown> = {}): Parameters<typeof setFilesViaCdp>[0] {
  const send = vi.fn().mockResolvedValue({});
  return {
    page: { waitForTimeout: vi.fn().mockResolvedValue(undefined) } as never,
    target: { evaluate: vi.fn().mockResolvedValue(true) } as never,
    session: { send } as never,
    backendNodeId: 7,
    fixture,
    logger: logger as never,
    signalCounter: { n: 0 },
    recentCaptureMeta: [],
    ...extra,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("setFilesViaCdp remote session", () => {
  it("posts to the uploads endpoint and uses the remote path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const params = makeParams({ browserbaseSessionId: "sess-1" });
    await setFilesViaCdp(params);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { body: FormData }];
    expect(url).toMatch(/\/v1\/sessions\/sess-1\/uploads$/);
    expect(init.method).toBe("POST");
    expect(init.body.get("file")).toBeInstanceOf(Blob);
    expect(params.session.send).toHaveBeenCalledWith("DOM.setFileInputFiles", {
      files: ["/tmp/.uploads/resume.pdf"],
      backendNodeId: 7,
    });
  });

  it("returns false without DOM call on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const params = makeParams({ browserbaseSessionId: "sess-1" });
    expect(await setFilesViaCdp(params)).toBe(false);
    expect(params.session.send).not.toHaveBeenCalled();
  });

  it("returns false without DOM call when the POST throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const params = makeParams({ browserbaseSessionId: "sess-1" });
    expect(await setFilesViaCdp(params)).toBe(false);
    expect(params.session.send).not.toHaveBeenCalled();
  });

  it("uses a temp file and no fetch without a session id", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const params = makeParams();
    await setFilesViaCdp(params).catch(() => false);
    expect(fetchMock).not.toHaveBeenCalled();
    const call = vi.mocked(params.session.send).mock.calls[0] ?? [];
    expect(call[0]).toBe("DOM.setFileInputFiles");
    expect((call[1] as { files: string[] }).files[0]).not.toContain("/tmp/.uploads/");
  });
});
