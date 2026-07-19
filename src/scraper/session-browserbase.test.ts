/**
 * Tests for makeFilteredStagehandLogger's elementId-regex suppression
 * counter — the pure logger-filtering unit inside session-browserbase.ts.
 * We drive the callback directly with fake LogLine objects rather than
 * spinning up a real Stagehand session.
 */

import { describe, expect, it, vi } from "vitest";

import { makeFilteredStagehandLogger } from "@/scraper/session-browserbase";
import type { Logger } from "@/types/logging";

const elementIdErrorLine = {
  category: "AISDK error",
  message: "AISDK error",
  level: 0,
  auxiliary: {
    cause: {
      value: "AI_TypeValidationError: Type validation failed for elementId",
      type: "string",
    },
  },
};

const unrelatedAisdkErrorLine = {
  category: "AISDK error",
  message: "rate limited",
  level: 0,
  auxiliary: {
    cause: { value: "RateLimitError: too many requests", type: "string" },
  },
};

const infoLine = {
  category: "action",
  message: "clicked element",
  level: 1,
};

function makeLoggerStub(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

describe("makeFilteredStagehandLogger", () => {
  it("starts with a suppressed count of zero", () => {
    const { getSuppressedCount } = makeFilteredStagehandLogger(makeLoggerStub());
    expect(getSuppressedCount()).toBe(0);
  });

  it("counts only AI_TypeValidationError/elementId lines and passes through the rest", () => {
    const pinoLogger = makeLoggerStub();
    const { callback, getSuppressedCount } = makeFilteredStagehandLogger(pinoLogger);

    callback(elementIdErrorLine);
    callback(unrelatedAisdkErrorLine);
    callback(infoLine);
    callback(elementIdErrorLine);

    expect(getSuppressedCount()).toBe(2);
    // Suppressed lines never reach pino.
    expect(pinoLogger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("elementId")
    );
    // Non-matching lines still pass through.
    expect(pinoLogger.error).toHaveBeenCalledWith({ stagehand: "AISDK error" }, "rate limited");
    expect(pinoLogger.info).toHaveBeenCalledWith({ stagehand: "action" }, "clicked element");
  });

  it("getSuppressedCount reflects the running total live, before reportSuppressed is called", () => {
    const { callback, reportSuppressed, getSuppressedCount } = makeFilteredStagehandLogger(
      makeLoggerStub()
    );

    callback(elementIdErrorLine);
    expect(getSuppressedCount()).toBe(1);

    callback(elementIdErrorLine);
    expect(getSuppressedCount()).toBe(2);

    reportSuppressed();
    expect(getSuppressedCount()).toBe(2);
  });

  it("reportSuppressed logs the final count once at teardown, byte-identical message", () => {
    const pinoLogger = makeLoggerStub();
    const { callback, reportSuppressed } = makeFilteredStagehandLogger(pinoLogger);

    callback(elementIdErrorLine);
    callback(elementIdErrorLine);
    reportSuppressed();

    expect(pinoLogger.info).toHaveBeenCalledWith(
      "stagehand-logger: suppressed 2 AISDK elementId-regex errors (upstream Stagehand bug; cascade Fix 1B handles consequence)"
    );
  });

  it("reportSuppressed logs nothing when the count is zero", () => {
    const pinoLogger = makeLoggerStub();
    const { reportSuppressed } = makeFilteredStagehandLogger(pinoLogger);

    reportSuppressed();

    expect(pinoLogger.info).not.toHaveBeenCalled();
  });
});
