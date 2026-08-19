import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startCdpTransportHeartbeat } from "@/scraper/cdp-heartbeat";
import type { Logger } from "@/types/logging";

function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  } as unknown as Logger;
}

describe("startCdpTransportHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues one send() call per elapsed heartbeat interval", async () => {
    const conn = { send: vi.fn().mockResolvedValue(undefined) };
    const handle = startCdpTransportHeartbeat(conn, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(conn.send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(conn.send).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(conn.send).toHaveBeenCalledTimes(5);

    handle.stop();
  });

  it("catches a send() rejection, logs it, and keeps ticking", async () => {
    const conn = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error("socket-close code=1006"))
        .mockResolvedValue(undefined),
    };
    const logger = fakeLogger();
    const handle = startCdpTransportHeartbeat(conn, { intervalMs: 1_000, logger });

    await expect(vi.advanceTimersByTimeAsync(1_000)).resolves.toBeUndefined();
    expect(conn.send).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(conn.send).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it("stop() clears the interval so no further send() calls occur", async () => {
    const conn = { send: vi.fn().mockResolvedValue(undefined) };
    const handle = startCdpTransportHeartbeat(conn, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(conn.send).toHaveBeenCalledTimes(1);

    handle.stop();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(conn.send).toHaveBeenCalledTimes(1);
  });
});
