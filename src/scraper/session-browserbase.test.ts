/**
 * Tests for makeFilteredStagehandLogger's elementId-regex suppression —
 * the pure logger-filtering unit inside session-browserbase.ts. We drive
 * the callback directly with fake LogLine objects rather than spinning up
 * a real Stagehand session.
 *
 * Two concerns are covered together: the live `getSuppressedCount`
 * accessor the cascade reads mid-step, and the strictness of the
 * suppression predicate itself — the filter must stay scoped to the
 * Stagehand-library "N-N" regex bug and never swallow unrelated AISDK failures.
 */

import { Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { startCdpTransportHeartbeat } from "@/scraper/cdp-heartbeat";
import { isCdpTransportClosedError } from "@/scraper/errors";
import { createBrowserSession } from "@/scraper/session";
import {
  createBrowserbaseBrowserSession,
  makeFilteredStagehandLogger,
  makeOutboundIpAccessor,
  type StagehandLogLine,
} from "@/scraper/session-browserbase";
import type { Logger } from "@/types/logging";

const { configRef } = vi.hoisted(() => ({
  configRef: {
    value: {
      scraper: {
        browserbaseApiKey: "bb-key" as string | undefined,
        browserbaseProjectId: "bb-project" as string | undefined,
        anthropicApiKey: "anthropic-key" as string | undefined,
        useBedrock: false,
        model: "anthropic/claude-sonnet-4-6",
        proxyType: "residential",
        solveCaptcha: true,
        anthropicTimeoutMs: 120000,
        captureSessionIp: true,
        sessionIpEchoUrl: "https://api.ipify.org?format=json",
        sessionIpTimeoutMs: 10000,
        provider: "browserbase" as "browserbase" | "steel",
        sessionCreateMaxConcurrent: 2,
        sessionCreateMinIntervalMs: 250,
        sessionCreateMaxRetries: 3,
      },
      bedrock: {
        region: "us-east-1",
        model: "test",
        accessKeyId: undefined,
        secretAccessKey: undefined,
        sessionToken: undefined,
      },
    },
  },
}));

vi.mock("@/config", () => ({
  get config() {
    return configRef.value;
  },
}));

const { fakePage } = vi.hoisted(() => ({
  fakePage: {
    getSessionForFrame: vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      off: vi.fn(),
    }),
    mainFrameId: vi.fn().mockReturnValue("main-frame"),
    frameForId: vi.fn().mockReturnValue({ evaluate: vi.fn().mockResolvedValue(undefined) }),
  },
}));

vi.mock("@browserbasehq/stagehand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@browserbasehq/stagehand")>();
  return {
    ...actual,
    Stagehand: vi.fn(function (this: Record<string, unknown>) {
      this.init = vi.fn().mockResolvedValue(undefined);
      this.close = vi.fn().mockResolvedValue(undefined);
      this.browserbaseSessionID = "bb-session-id";
      this.context = {
        conn: { send: vi.fn().mockResolvedValue(undefined), onTransportClosed: vi.fn() },
        addInitScript: vi.fn().mockResolvedValue(undefined),
        awaitActivePage: vi.fn().mockResolvedValue(fakePage),
      };
    }),
  };
});

vi.mock("steel-sdk", () => ({
  default: vi.fn(function (this: Record<string, unknown>) {
    this.sessions = {
      create: vi.fn().mockResolvedValue({
        id: "steel-session-id",
        websocketUrl: "wss://connect.steel.dev?sessionId=steel-session-id",
      }),
      release: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

const { heartbeatHandleRef } = vi.hoisted(() => ({
  heartbeatHandleRef: { value: { stop: vi.fn() } },
}));

vi.mock("@/scraper/cdp-heartbeat", () => ({
  startCdpTransportHeartbeat: vi.fn((..._args: unknown[]) => {
    heartbeatHandleRef.value = { stop: vi.fn() };
    return heartbeatHandleRef.value;
  }),
}));

vi.mock("@/lib/bedrock", () => ({
  createBedrockModel: vi.fn(() => ({ specificationVersion: "v2" })),
}));

vi.mock("@/scraper/session-ip", () => ({
  resolveSessionOutboundIp: vi.fn(),
}));

vi.mock("@/scraper/throttle", () => ({
  createSessionLimiter: vi.fn(() => ({
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

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

  it("suppresses the Stagehand-library N-N regex schema error instead of logging it", () => {
    const pinoLogger = makeLoggerStub();
    const { callback, reportSuppressed } = makeFilteredStagehandLogger(pinoLogger);

    callback(aisdkLine("AI_TypeValidationError: invalid elementId format, expected N-N"));

    expect(pinoLogger.error).not.toHaveBeenCalled();
    expect(pinoLogger.info).not.toHaveBeenCalled();
    expect(pinoLogger.debug).not.toHaveBeenCalled();

    reportSuppressed();
    expect(pinoLogger.info).toHaveBeenCalledOnce();
    expect(pinoLogger.info).toHaveBeenCalledWith(
      "stagehand-logger: suppressed 1 AISDK elementId-regex errors (Stagehand bug; cascade Fix 1B handles consequence)"
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
      "stagehand-logger: suppressed 2 AISDK elementId-regex errors (Stagehand bug; cascade Fix 1B handles consequence)"
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
      "stagehand-logger: suppressed 3 AISDK elementId-regex errors (Stagehand bug; cascade Fix 1B handles consequence)"
    );
  });

  it("reportSuppressed logs nothing when the count is zero", () => {
    const pinoLogger = makeLoggerStub();
    const { reportSuppressed } = makeFilteredStagehandLogger(pinoLogger);

    reportSuppressed();

    expect(pinoLogger.info).not.toHaveBeenCalled();
  });
});

describe("makeOutboundIpAccessor", () => {
  it("triggers exactly one resolve for two concurrent calls and shares the result", async () => {
    const resolve = vi.fn().mockResolvedValue("203.0.113.7");
    const getOutboundIp = makeOutboundIpAccessor(resolve, { enabled: true });

    const [first, second] = await Promise.all([getOutboundIp(), getOutboundIp()]);

    expect(first).toBe("203.0.113.7");
    expect(second).toBe("203.0.113.7");
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("returns the memoized value on a later call without re-resolving", async () => {
    const resolve = vi.fn().mockResolvedValue("203.0.113.7");
    const getOutboundIp = makeOutboundIpAccessor(resolve, { enabled: true });

    await getOutboundIp();
    expect(await getOutboundIp()).toBe("203.0.113.7");
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("resolves null without ever invoking the resolver when disabled", async () => {
    const resolve = vi.fn().mockResolvedValue("203.0.113.7");
    const getOutboundIp = makeOutboundIpAccessor(resolve, { enabled: false });

    expect(await getOutboundIp()).toBeNull();
    expect(await getOutboundIp()).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("surfaces a rejecting resolver as a resolved null, never a rejection", async () => {
    const resolve = vi.fn().mockRejectedValue(new Error("echo navigation failed"));
    const getOutboundIp = makeOutboundIpAccessor(resolve, { enabled: true });

    await expect(getOutboundIp()).resolves.toBeNull();
    // Memoizes the rejection-turned-null too — a second call doesn't retry.
    await expect(getOutboundIp()).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledOnce();
  });
});

describe("createBrowserbaseBrowserSession keepAlive", () => {
  beforeEach(() => {
    configRef.value.scraper.browserbaseApiKey = "bb-key";
    configRef.value.scraper.browserbaseProjectId = "bb-project";
    configRef.value.scraper.anthropicApiKey = "anthropic-key";
    configRef.value.scraper.useBedrock = false;
    vi.clearAllMocks();
  });

  it("passes keepAlive:true so Stagehand's out-of-process shutdown supervisor never spawns", async () => {
    await createBrowserbaseBrowserSession();

    const stagehandArg = vi.mocked(Stagehand).mock.calls.at(-1)?.[0] as { keepAlive?: boolean };

    expect(stagehandArg.keepAlive).toBe(true);
  });
});

describe("createBrowserbaseBrowserSession teardown-detector composition", () => {
  beforeEach(() => {
    configRef.value.scraper.browserbaseApiKey = "bb-key";
    configRef.value.scraper.browserbaseProjectId = "bb-project";
    configRef.value.scraper.anthropicApiKey = "anthropic-key";
    configRef.value.scraper.useBedrock = false;
    vi.clearAllMocks();
  });

  it("exposes a deathSignal that rejects when the composed logger callback observes a teardown line", async () => {
    const session = await createBrowserbaseBrowserSession();

    const stagehandArg = vi.mocked(Stagehand).mock.calls.at(-1)?.[0] as {
      logger?: (line: StagehandLogLine) => void;
    };
    const loggerCallback = stagehandArg.logger;
    expect(loggerCallback).toBeInstanceOf(Function);
    expect(session.deathSignal).toBeInstanceOf(Promise);

    const assertion = expect(session.deathSignal).rejects.toThrow(
      "stagehand-initiated teardown mid-flow"
    );
    loggerCallback?.({
      message: "CDP transport closed",
      category: "connection",
      level: 0,
    });
    await assertion;
  });

  it("still suppresses AISDK elementId spam through the composed callback (existing behavior preserved)", async () => {
    const session = await createBrowserbaseBrowserSession();

    const stagehandArg = vi.mocked(Stagehand).mock.calls.at(-1)?.[0] as {
      logger?: (line: StagehandLogLine) => void;
    };
    const loggerCallback = stagehandArg.logger;

    expect(() => loggerCallback?.(elementIdErrorLine)).not.toThrow();
    expect(session.getSuppressedAisdkElementIdErrorCount?.()).toBe(1);
  });
});

describe("createBrowserbaseBrowserSession CDP heartbeat", () => {
  beforeEach(() => {
    configRef.value.scraper.browserbaseApiKey = "bb-key";
    configRef.value.scraper.browserbaseProjectId = "bb-project";
    configRef.value.scraper.anthropicApiKey = "anthropic-key";
    configRef.value.scraper.useBedrock = false;
    vi.clearAllMocks();
  });

  it("starts the heartbeat against stagehand.context.conn after init resolves, and stop() ends it before no calls fire after close", async () => {
    const session = await createBrowserbaseBrowserSession();

    const stagehandInstance = vi.mocked(Stagehand).mock.instances.at(-1) as unknown as {
      context: { conn: unknown };
    };
    expect(vi.mocked(startCdpTransportHeartbeat)).toHaveBeenCalledWith(
      stagehandInstance.context.conn,
      expect.anything()
    );

    const handle = vi.mocked(startCdpTransportHeartbeat).mock.results.at(-1)?.value as {
      stop: ReturnType<typeof vi.fn>;
    };

    await session.close();

    expect(handle.stop).toHaveBeenCalledOnce();
  });
});

describe("createBrowserbaseBrowserSession CDP-transport-teardown detection", () => {
  beforeEach(() => {
    configRef.value.scraper.browserbaseApiKey = "bb-key";
    configRef.value.scraper.browserbaseProjectId = "bb-project";
    configRef.value.scraper.anthropicApiKey = "anthropic-key";
    configRef.value.scraper.useBedrock = false;
    vi.clearAllMocks();
  });

  it("flags an SDK-initiated transport close that happens before our own close()", async () => {
    const session = await createBrowserbaseBrowserSession();
    const fakeStagehand = session.stagehand as unknown as {
      context: { conn: { onTransportClosed: ReturnType<typeof vi.fn> } };
    };
    const handler = fakeStagehand.context.conn.onTransportClosed.mock.calls[0]?.[0] as (
      why: string
    ) => void;

    handler("socket-close code=1006 reason=");

    const err = session.getCdpTransportClosedError?.();
    expect(err).toBeDefined();
    expect(isCdpTransportClosedError(err)).toBe(true);
    expect(err?.message).toContain("socket-close code=1006 reason=");
  });

  it("does not flag a transport close that happens as a consequence of our own close()", async () => {
    const session = await createBrowserbaseBrowserSession();
    const fakeStagehand = session.stagehand as unknown as {
      context: { conn: { onTransportClosed: ReturnType<typeof vi.fn> } };
    };
    const handler = fakeStagehand.context.conn.onTransportClosed.mock.calls[0]?.[0] as (
      why: string
    ) => void;

    await session.close();
    handler("socket-close code=1000 reason=normal-close");

    expect(session.getCdpTransportClosedError?.()).toBeUndefined();
  });

  it("never flags an unrelated error-level Stagehand log line, even one shaped like the SDK's own teardown text", async () => {
    const session = await createBrowserbaseBrowserSession();
    const stagehandArg = vi.mocked(Stagehand).mock.calls.at(-1)?.[0] as {
      logger?: (line: StagehandLogLine) => void;
    };

    // Driven through the Stagehand `logger` callback (makeFilteredStagehandLogger's
    // callback) rather than through context.conn.onTransportClosed — the actual
    // detection signal wired above. Detection here must stay anchored to the SDK's
    // own onTransportClosed hook, not to matching log text, so neither an unrelated
    // AISDK failure nor Stagehand's own teardown wording accidentally flips the
    // detector via the logger path.
    stagehandArg.logger?.({
      message: "AI_TypeValidationError: Type validation failed for someOtherField",
      category: "AISDK error",
      level: 0,
    });
    stagehandArg.logger?.({
      message: "initiating shutdown → CDP transport closed: socket-close code=1006 reason=",
      category: "stagehand:v3",
      level: 0,
    });

    expect(session.getCdpTransportClosedError?.()).toBeUndefined();
  });
});

describe("createBrowserSession session-create-limiter wiring around the real Stagehand.init call", () => {
  beforeEach(() => {
    configRef.value.scraper.provider = "browserbase";
    configRef.value.scraper.browserbaseApiKey = "bb-key";
    configRef.value.scraper.browserbaseProjectId = "bb-project";
    configRef.value.scraper.anthropicApiKey = "anthropic-key";
    configRef.value.scraper.useBedrock = false;
    vi.clearAllMocks();
  });

  it("retries a 'Unknown error: 429' from stagehand.init() and resolves, instead of failing the first attempt", async () => {
    vi.mocked(Stagehand).mockImplementationOnce(function (this: Record<string, unknown>) {
      this.init = vi.fn().mockRejectedValue(new Error("Unknown error: 429"));
      this.close = vi.fn().mockResolvedValue(undefined);
      this.browserbaseSessionID = "bb-session-id";
      this.context = {
        conn: { send: vi.fn().mockResolvedValue(undefined), onTransportClosed: vi.fn() },
        addInitScript: vi.fn().mockResolvedValue(undefined),
        awaitActivePage: vi.fn().mockResolvedValue(fakePage),
      };
    } as unknown as typeof Stagehand);

    const session = await createBrowserSession();

    expect(session.provider).toBe("browserbase");
    expect(vi.mocked(Stagehand)).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-429 init failure without retry or masking", async () => {
    vi.mocked(Stagehand).mockImplementationOnce(function (this: Record<string, unknown>) {
      this.init = vi.fn().mockRejectedValue(new Error("ECONNRESET: connection reset"));
      this.close = vi.fn().mockResolvedValue(undefined);
      this.browserbaseSessionID = "bb-session-id";
      this.context = {
        conn: { send: vi.fn().mockResolvedValue(undefined), onTransportClosed: vi.fn() },
        addInitScript: vi.fn().mockResolvedValue(undefined),
        awaitActivePage: vi.fn().mockResolvedValue(fakePage),
      };
    } as unknown as typeof Stagehand);

    await expect(createBrowserSession()).rejects.toThrow("ECONNRESET: connection reset");
    expect(vi.mocked(Stagehand)).toHaveBeenCalledTimes(1);
  });
});
