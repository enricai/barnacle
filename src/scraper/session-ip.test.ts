import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type EchoPage, resolveSessionOutboundIp } from "@/scraper/session-ip";

function fakePage(overrides: Partial<EchoPage> = {}): EchoPage {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(""),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("resolveSessionOutboundIp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("extracts the IP from an ipify-style JSON body", async () => {
    const page = fakePage({ evaluate: vi.fn().mockResolvedValue('{"ip":"203.0.113.42"}') });
    const newPage = vi.fn().mockResolvedValue(page);

    const result = await resolveSessionOutboundIp(newPage, {
      echoUrl: "https://echo.example/json",
      timeoutMs: 5_000,
    });

    expect(result).toBe("203.0.113.42");
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("extracts the IP from a bare-text body", async () => {
    const page = fakePage({ evaluate: vi.fn().mockResolvedValue("  203.0.113.42  ") });
    const newPage = vi.fn().mockResolvedValue(page);

    const result = await resolveSessionOutboundIp(newPage, {
      echoUrl: "https://echo.example/plain",
      timeoutMs: 5_000,
    });

    expect(result).toBe("203.0.113.42");
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("resolves null for a captive-portal HTML body instead of persisting garbage", async () => {
    const page = fakePage({
      evaluate: vi
        .fn()
        .mockResolvedValue("<html><body>Please sign in to the WiFi network</body></html>"),
    });
    const newPage = vi.fn().mockResolvedValue(page);

    const result = await resolveSessionOutboundIp(newPage, {
      echoUrl: "https://echo.example/json",
      timeoutMs: 5_000,
    });

    expect(result).toBeNull();
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("resolves null for any other non-IP text body", async () => {
    const page = fakePage({ evaluate: vi.fn().mockResolvedValue("not an ip address") });
    const newPage = vi.fn().mockResolvedValue(page);

    const result = await resolveSessionOutboundIp(newPage, {
      echoUrl: "https://echo.example/json",
      timeoutMs: 5_000,
    });

    expect(result).toBeNull();
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("cuts off a hung navigation via the watchdog and resolves null, closing the tab", async () => {
    const page = fakePage({ goto: vi.fn().mockImplementation(() => new Promise(() => {})) });
    const newPage = vi.fn().mockResolvedValue(page);
    const logger = { warn: vi.fn() };

    const promise = resolveSessionOutboundIp(newPage, {
      echoUrl: "https://echo.example/json",
      timeoutMs: 5_000,
      logger: logger as never,
    });
    const assertion = expect(promise).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;

    expect(page.close).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("session outbound ip resolution failed")
    );
  });

  it("resolves null and still closes the tab when the page throws", async () => {
    const page = fakePage({ goto: vi.fn().mockRejectedValue(new Error("navigation crashed")) });
    const newPage = vi.fn().mockResolvedValue(page);
    const logger = { warn: vi.fn() };

    const result = await resolveSessionOutboundIp(newPage, {
      echoUrl: "https://echo.example/json",
      timeoutMs: 5_000,
      logger: logger as never,
    });

    expect(result).toBeNull();
    expect(page.close).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("session outbound ip resolution failed: navigation crashed")
    );
  });

  it("resolves null and never rejects when the page factory itself throws", async () => {
    const newPage = vi.fn().mockRejectedValue(new Error("could not open tab"));

    const result = await resolveSessionOutboundIp(newPage, {
      echoUrl: "https://echo.example/json",
      timeoutMs: 5_000,
    });

    expect(result).toBeNull();
  });

  it("does not throw when close() itself rejects, on the success path", async () => {
    const page = fakePage({
      evaluate: vi.fn().mockResolvedValue("203.0.113.42"),
      close: vi.fn().mockRejectedValue(new Error("close failed")),
    });
    const newPage = vi.fn().mockResolvedValue(page);
    const logger = { warn: vi.fn() };

    const result = await resolveSessionOutboundIp(newPage, {
      echoUrl: "https://echo.example/json",
      timeoutMs: 5_000,
      logger: logger as never,
    });

    expect(result).toBe("203.0.113.42");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("session outbound ip echo tab close failed: close failed")
    );
  });

  it("does not throw when close() itself rejects, on the timeout path", async () => {
    const page = fakePage({
      goto: vi.fn().mockImplementation(() => new Promise(() => {})),
      close: vi.fn().mockRejectedValue(new Error("close failed")),
    });
    const newPage = vi.fn().mockResolvedValue(page);

    const promise = resolveSessionOutboundIp(newPage, {
      echoUrl: "https://echo.example/json",
      timeoutMs: 5_000,
    });
    const assertion = expect(promise).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("never throws when no logger is supplied on a failure path", async () => {
    const page = fakePage({ goto: vi.fn().mockRejectedValue(new Error("boom")) });
    const newPage = vi.fn().mockResolvedValue(page);

    await expect(
      resolveSessionOutboundIp(newPage, { echoUrl: "https://echo.example/json", timeoutMs: 5_000 })
    ).resolves.toBeNull();
  });
});
