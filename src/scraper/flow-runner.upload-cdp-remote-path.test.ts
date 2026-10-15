import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { setFilesViaCdp } from "@/scraper/flow-runner";

const fixture = { buffer: Buffer.from("hello"), name: "resume.pdf", mimeType: "application/pdf" };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function makeParams(extra: Record<string, unknown> = {}): Parameters<typeof setFilesViaCdp>[0] {
  return {
    page: { waitForTimeout: vi.fn().mockResolvedValue(undefined) } as never,
    target: { evaluate: vi.fn().mockResolvedValue(false) } as never,
    session: { send: vi.fn().mockResolvedValue({}) } as never,
    backendNodeId: 7,
    fixture,
    logger: logger as never,
    signalCounter: { n: 0 },
    recentCaptureMeta: [],
    ...extra,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("setFilesViaCdp path selection", () => {
  it("posts once to the session uploads endpoint and passes the remote path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const params = makeParams({ browserbaseSessionId: "sess-9" });
    await setFilesViaCdp(params);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/sessions/sess-9/uploads");
    expect(init.method).toBe("POST");
    expect(params.session.send).toHaveBeenCalledWith("DOM.setFileInputFiles", {
      files: ["/tmp/.uploads/resume.pdf"],
      backendNodeId: 7,
    });
  });

  it("keeps a host temp path and skips fetch without a session id", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const params = makeParams();
    await setFilesViaCdp(params);
    expect(fetchMock).not.toHaveBeenCalled();
    const call = vi.mocked(params.session.send).mock.calls[0] ?? [];
    expect(call[0]).toBe("DOM.setFileInputFiles");
    expect((call[1] as { files: string[] }).files[0]?.startsWith(tmpdir())).toBe(true);
  });

  it.each([400, 404, 500])("returns false and skips the DOM call on status %i", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status }));
    const params = makeParams({ browserbaseSessionId: "sess-9" });
    expect(await setFilesViaCdp(params)).toBe(false);
    expect(params.session.send).not.toHaveBeenCalled();
  });
});
