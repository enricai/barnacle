/**
 * Tests for makeFilteredStagehandLogger's elementId-regex suppression —
 * the pure logger-filtering unit inside session-browserbase.ts. We drive
 * the callback directly with fake LogLine objects rather than spinning up
 * a real Stagehand session.
 *
 * Two concerns are covered together: the live `getSuppressedCount`
 * accessor the cascade reads mid-step, and the strictness of the
 * suppression predicate itself — the filter must stay scoped to the
 * upstream "N-N" regex bug and never swallow unrelated AISDK failures.
 */

import { describe, expect, it, vi } from "vitest";

import { makeFilteredStagehandLogger, type StagehandLogLine } from "@/scraper/session-browserbase";
import type { Logger } from "@/types/logging";

function makeLoggerStub(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  } as unknown as Logger;
}

function aisdkLine(cause: string, overrides?: Partial<StagehandLogLine>): StagehandLogLine {
  return {
    message: "AISDK error",
    category: "AISDK error",
    level: 0,
    auxiliary: { cause: { value: cause, type: "string" } },
    ...overrides,
  };
}

const elementIdErrorLine = aisdkLine(
  "AI_TypeValidationError: Type validation failed for elementId"
);

const unrelatedAisdkErrorLine = aisdkLine("RateLimitError: too many requests", {
  message: "rate limited",
});

const infoLine: StagehandLogLine = {
  category: "action",
  message: "clicked element",
  level: 1,
};

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

  it("suppresses the upstream N-N regex schema error instead of logging it", () => {
    const pinoLogger = makeLoggerStub();
    const { callback, reportSuppressed } = makeFilteredStagehandLogger(pinoLogger);

    callback(aisdkLine("AI_TypeValidationError: invalid elementId format, expected N-N"));

    expect(pinoLogger.error).not.toHaveBeenCalled();
    expect(pinoLogger.info).not.toHaveBeenCalled();
    expect(pinoLogger.debug).not.toHaveBeenCalled();

    reportSuppressed();
    expect(pinoLogger.info).toHaveBeenCalledOnce();
    expect(pinoLogger.info).toHaveBeenCalledWith(
      "stagehand-logger: suppressed 1 AISDK elementId-regex errors (upstream Stagehand bug; cascade Fix 1B handles consequence)"
    );
  });

  it("does not suppress an AI_TypeValidationError whose cause omits elementId", () => {
    const pinoLogger = makeLoggerStub();
    const { callback } = makeFilteredStagehandLogger(pinoLogger);

    callback(aisdkLine("AI_TypeValidationError: invalid format for someOtherField"));

    expect(pinoLogger.error).toHaveBeenCalledOnce();
  });

  it("does not suppress an elementId cause that lacks AI_TypeValidationError", () => {
    const pinoLogger = makeLoggerStub();
    const { callback } = makeFilteredStagehandLogger(pinoLogger);

    callback(aisdkLine("elementId lookup failed: some other cause"));

    expect(pinoLogger.error).toHaveBeenCalledOnce();
  });

  it("passes through an AISDK rate-limit error unsuppressed so it never hides behind the filter", () => {
    const pinoLogger = makeLoggerStub();
    const { callback } = makeFilteredStagehandLogger(pinoLogger);

    callback(aisdkLine("RateLimitError: too many requests, retry after 30s"));

    expect(pinoLogger.error).toHaveBeenCalledOnce();
    expect(pinoLogger.error).toHaveBeenCalledWith({ stagehand: "AISDK error" }, "AISDK error");
  });

  it("passes through a malformed-request AISDK error unsuppressed", () => {
    const pinoLogger = makeLoggerStub();
    const { callback } = makeFilteredStagehandLogger(pinoLogger);

    callback(aisdkLine("BadRequestError: malformed request body"));

    expect(pinoLogger.error).toHaveBeenCalledOnce();
  });

  it("routes non-AISDK log lines through pino at the matching level", () => {
    const pinoLogger = makeLoggerStub();
    const { callback } = makeFilteredStagehandLogger(pinoLogger);

    callback({ message: "navigating to page", category: "action", level: 1 });
    expect(pinoLogger.info).toHaveBeenCalledWith({ stagehand: "action" }, "navigating to page");

    callback({ message: "cache hit", category: "cache", level: 2 });
    expect(pinoLogger.debug).toHaveBeenCalledWith({ stagehand: "cache" }, "cache hit");

    callback({ message: "fatal crash", category: "core", level: 0 });
    expect(pinoLogger.error).toHaveBeenCalledWith({ stagehand: "core" }, "fatal crash");
  });

  it("treats a missing cause as non-matching and forwards the line", () => {
    const pinoLogger = makeLoggerStub();
    const { callback } = makeFilteredStagehandLogger(pinoLogger);

    callback({ message: "AISDK error", category: "AISDK error", level: 0 });

    expect(pinoLogger.error).toHaveBeenCalledOnce();
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

  it("reports the exact accumulated count across multiple suppressed lines", () => {
    const pinoLogger = makeLoggerStub();
    const { callback, reportSuppressed } = makeFilteredStagehandLogger(pinoLogger);

    callback(aisdkLine("AI_TypeValidationError: elementId N-N mismatch"));
    callback(aisdkLine("AI_TypeValidationError: elementId N-N mismatch"));
    callback(aisdkLine("AI_TypeValidationError: elementId N-N mismatch"));

    reportSuppressed();
    expect(pinoLogger.info).toHaveBeenCalledWith(
      "stagehand-logger: suppressed 3 AISDK elementId-regex errors (upstream Stagehand bug; cascade Fix 1B handles consequence)"
    );
  });

  it("reportSuppressed logs nothing when the count is zero", () => {
    const pinoLogger = makeLoggerStub();
    const { reportSuppressed } = makeFilteredStagehandLogger(pinoLogger);

    reportSuppressed();

    expect(pinoLogger.info).not.toHaveBeenCalled();
  });
});
