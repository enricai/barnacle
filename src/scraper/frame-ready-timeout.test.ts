import { describe, expect, it, vi } from "vitest";

import {
  FRAME_READY_TIMEOUT_DEFAULT_MS,
  resolveFrameReadyTimeoutMs,
} from "@/scraper/frame-ready-timeout";
import type { Logger } from "@/types/logging";

function makeLoggerStub() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  };
}

describe("scraper/frame-ready-timeout/resolveFrameReadyTimeoutMs", () => {
  it("raises the default well above the historical 5s so a slow-attaching OOPIF has room", () => {
    expect(FRAME_READY_TIMEOUT_DEFAULT_MS).toBeGreaterThanOrEqual(15_000);
  });

  it("resolves to the default when the override is unset", () => {
    const log = makeLoggerStub();
    expect(resolveFrameReadyTimeoutMs({}, undefined, log as unknown as Logger)).toBe(
      FRAME_READY_TIMEOUT_DEFAULT_MS
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("resolves to the parsed value for a valid positive integer override", () => {
    const log = makeLoggerStub();
    expect(resolveFrameReadyTimeoutMs({}, "15000", log as unknown as Logger)).toBe(15_000);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("trims whitespace around a valid override", () => {
    const log = makeLoggerStub();
    expect(resolveFrameReadyTimeoutMs({}, "  7500  ", log as unknown as Logger)).toBe(7500);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["blank string", ""],
    ["whitespace-only", "   "],
    ["non-numeric", "soon"],
    ["zero", "0"],
    ["negative", "-100"],
  ])("falls back to the default with a warn for a %s override", (_label, raw) => {
    const log = makeLoggerStub();
    expect(resolveFrameReadyTimeoutMs({}, raw, log as unknown as Logger)).toBe(
      FRAME_READY_TIMEOUT_DEFAULT_MS
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("FRAME_READY_TIMEOUT_MS"));
  });

  it("prefers an explicit opts.timeoutMs over a valid env override", () => {
    const log = makeLoggerStub();
    expect(resolveFrameReadyTimeoutMs({ timeoutMs: 42 }, "15000", log as unknown as Logger)).toBe(
      42
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("prefers an explicit opts.timeoutMs over an invalid env override, without warning", () => {
    const log = makeLoggerStub();
    expect(
      resolveFrameReadyTimeoutMs({ timeoutMs: 42 }, "not-a-number", log as unknown as Logger)
    ).toBe(42);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("prefers an explicit opts.timeoutMs over the default when the env override is unset", () => {
    const log = makeLoggerStub();
    expect(resolveFrameReadyTimeoutMs({ timeoutMs: 42 }, undefined, log as unknown as Logger)).toBe(
      42
    );
    expect(log.warn).not.toHaveBeenCalled();
  });
});
