import { describe, expect, it, vi } from "vitest";

import { makeFilteredStagehandLogger, type StagehandLogLine } from "@/scraper/session-browserbase";

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({ getLogger: () => loggerStub }));

function aisdkLine(cause: string, overrides?: Partial<StagehandLogLine>): StagehandLogLine {
  return {
    message: "AISDK error",
    category: "AISDK error",
    level: 0,
    auxiliary: { cause: { value: cause, type: "string" } },
    ...overrides,
  };
}

describe("makeFilteredStagehandLogger", () => {
  it("suppresses the upstream N-N regex schema error and increments the counter instead of logging it", () => {
    loggerStub.info.mockClear();
    loggerStub.error.mockClear();
    const { callback, reportSuppressed } = makeFilteredStagehandLogger(loggerStub as never);

    callback(aisdkLine("AI_TypeValidationError: invalid elementId format, expected N-N"));

    expect(loggerStub.error).not.toHaveBeenCalled();
    expect(loggerStub.info).not.toHaveBeenCalled();
    expect(loggerStub.debug).not.toHaveBeenCalled();

    reportSuppressed();
    expect(loggerStub.info).toHaveBeenCalledOnce();
    expect(loggerStub.info).toHaveBeenCalledWith(
      "stagehand-logger: suppressed 1 AISDK elementId-regex errors (upstream Stagehand bug; cascade Fix 1B handles consequence)"
    );
  });

  it("does not suppress an AI_TypeValidationError whose cause omits elementId", () => {
    loggerStub.error.mockClear();
    const { callback, reportSuppressed } = makeFilteredStagehandLogger(loggerStub as never);

    callback(aisdkLine("AI_TypeValidationError: invalid format for someOtherField"));

    expect(loggerStub.error).toHaveBeenCalledOnce();
    reportSuppressed();
  });

  it("does not suppress an elementId cause that lacks AI_TypeValidationError", () => {
    loggerStub.error.mockClear();
    const { callback, reportSuppressed } = makeFilteredStagehandLogger(loggerStub as never);

    callback(aisdkLine("elementId lookup failed: some other cause"));

    expect(loggerStub.error).toHaveBeenCalledOnce();
    reportSuppressed();
  });

  it("passes through an AISDK rate-limit error unsuppressed so it never hides behind the filter", () => {
    loggerStub.error.mockClear();
    const { callback, reportSuppressed } = makeFilteredStagehandLogger(loggerStub as never);

    callback(aisdkLine("RateLimitError: too many requests, retry after 30s"));

    expect(loggerStub.error).toHaveBeenCalledOnce();
    expect(loggerStub.error).toHaveBeenCalledWith({ stagehand: "AISDK error" }, "AISDK error");
    reportSuppressed();
  });

  it("passes through a malformed-request AISDK error unsuppressed", () => {
    loggerStub.error.mockClear();
    const { callback, reportSuppressed } = makeFilteredStagehandLogger(loggerStub as never);

    callback(aisdkLine("BadRequestError: malformed request body"));

    expect(loggerStub.error).toHaveBeenCalledOnce();
    reportSuppressed();
  });

  it("routes non-AISDK log lines through pino at the matching level", () => {
    const { callback } = makeFilteredStagehandLogger(loggerStub as never);

    callback({ message: "navigating to page", category: "action", level: 1 });
    expect(loggerStub.info).toHaveBeenCalledWith({ stagehand: "action" }, "navigating to page");

    callback({ message: "cache hit", category: "cache", level: 2 });
    expect(loggerStub.debug).toHaveBeenCalledWith({ stagehand: "cache" }, "cache hit");

    callback({ message: "fatal crash", category: "core", level: 0 });
    expect(loggerStub.error).toHaveBeenCalledWith({ stagehand: "core" }, "fatal crash");
  });

  it("emits the teardown suppression summary only when suppressedCount is greater than zero", () => {
    loggerStub.info.mockClear();
    const { reportSuppressed } = makeFilteredStagehandLogger(loggerStub as never);

    reportSuppressed();

    expect(loggerStub.info).not.toHaveBeenCalled();
  });

  it("reports the exact accumulated count across multiple suppressed lines", () => {
    loggerStub.info.mockClear();
    const { callback, reportSuppressed } = makeFilteredStagehandLogger(loggerStub as never);

    callback(aisdkLine("AI_TypeValidationError: elementId N-N mismatch"));
    callback(aisdkLine("AI_TypeValidationError: elementId N-N mismatch"));
    callback(aisdkLine("AI_TypeValidationError: elementId N-N mismatch"));

    reportSuppressed();
    expect(loggerStub.info).toHaveBeenCalledWith(
      "stagehand-logger: suppressed 3 AISDK elementId-regex errors (upstream Stagehand bug; cascade Fix 1B handles consequence)"
    );
  });

  it("treats a missing cause as non-matching and forwards the line", () => {
    loggerStub.error.mockClear();
    const { callback, reportSuppressed } = makeFilteredStagehandLogger(loggerStub as never);

    callback({ message: "AISDK error", category: "AISDK error", level: 0 });

    expect(loggerStub.error).toHaveBeenCalledOnce();
    reportSuppressed();
  });
});
