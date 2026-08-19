/**
 * Asserts createSteelBrowserSession threads keepAlive:true into the
 * Stagehand constructor, so Stagehand's out-of-process shutdown supervisor
 * (which mistakes its own stdin lifeline pipe closing for "parent died" and
 * force-releases the session) never spawns. Barnacle already owns explicit
 * teardown via close()/release() in try/finally, so the supervisor is
 * redundant and its false-positive trigger is strictly worse than not
 * having it.
 */

import { Stagehand } from "@browserbasehq/stagehand";
import Steel from "steel-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isCdpTransportClosedError } from "@/scraper/errors";
import type { StagehandLogLine } from "@/scraper/session-browserbase";
import { createSteelBrowserSession } from "@/scraper/session-steel";

const { configRef } = vi.hoisted(() => ({
  configRef: {
    value: {
      scraper: {
        steelApiKey: "steel-key" as string | undefined,
        anthropicApiKey: "anthropic-key" as string | undefined,
        useBedrock: false,
        model: "anthropic/claude-sonnet-4-6",
        proxyType: "residential",
        solveCaptcha: true,
        anthropicTimeoutMs: 120000,
        steelSessionTimeoutMs: 3600000,
        captureSessionIp: true,
        sessionIpEchoUrl: "https://api.ipify.org?format=json",
        sessionIpTimeoutMs: 10000,
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

const { fakeConn } = vi.hoisted(() => ({
  fakeConn: { send: vi.fn().mockResolvedValue(undefined), onTransportClosed: vi.fn() },
}));

vi.mock("@browserbasehq/stagehand", () => ({
  AISdkClient: vi.fn(),
  Stagehand: vi.fn(function (this: Record<string, unknown>) {
    this.init = vi.fn().mockResolvedValue(undefined);
    this.close = vi.fn().mockResolvedValue(undefined);
    this.context = { conn: fakeConn };
  }),
}));

const { heartbeatStub, startCdpTransportHeartbeat } = vi.hoisted(() => {
  const heartbeatStub = { stop: vi.fn() };
  return { heartbeatStub, startCdpTransportHeartbeat: vi.fn(() => heartbeatStub) };
});

vi.mock("@/scraper/cdp-heartbeat", () => ({ startCdpTransportHeartbeat }));

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

vi.mock("@/lib/bedrock", () => ({
  createBedrockModel: vi.fn(() => ({ specificationVersion: "v2" })),
}));

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/logging", () => ({
  getLogger: () => loggerStub,
}));

vi.mock("@/scraper/throttle", () => ({
  createSessionLimiter: vi.fn(() => ({
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe("scraper/session-steel keepAlive", () => {
  beforeEach(() => {
    configRef.value.scraper.steelApiKey = "steel-key";
    configRef.value.scraper.anthropicApiKey = "anthropic-key";
    configRef.value.scraper.useBedrock = false;
    vi.clearAllMocks();
  });

  it("passes keepAlive:true so Stagehand's out-of-process shutdown supervisor never spawns", async () => {
    await createSteelBrowserSession();

    const stagehandArg = vi.mocked(Stagehand).mock.calls.at(-1)?.[0] as { keepAlive?: boolean };

    expect(stagehandArg.keepAlive).toBe(true);
  });

  it("starts the CDP heartbeat against stagehand.context.conn and stops it before steel.sessions.release() on close()", async () => {
    const session = await createSteelBrowserSession();

    expect(startCdpTransportHeartbeat).toHaveBeenCalledWith(
      fakeConn,
      expect.objectContaining({ logger: loggerStub })
    );
    expect(heartbeatStub.stop).not.toHaveBeenCalled();

    const steelInstance = vi.mocked(Steel).mock.results.at(-1)?.value as {
      sessions: { release: ReturnType<typeof vi.fn> };
    };

    await session.close();

    expect(heartbeatStub.stop).toHaveBeenCalledTimes(1);
    const stopOrder = heartbeatStub.stop.mock.invocationCallOrder.at(0) ?? -1;
    const releaseOrder = steelInstance.sessions.release.mock.invocationCallOrder.at(0) ?? -1;
    expect(stopOrder).toBeGreaterThanOrEqual(0);
    expect(stopOrder).toBeLessThan(releaseOrder);
  });
});

describe("scraper/session-steel teardown-detector composition", () => {
  beforeEach(() => {
    configRef.value.scraper.steelApiKey = "steel-key";
    configRef.value.scraper.anthropicApiKey = "anthropic-key";
    configRef.value.scraper.useBedrock = false;
    vi.clearAllMocks();
  });

  it("passes a logger callback to Stagehand that forwards ordinary lines to pino", async () => {
    await createSteelBrowserSession();

    const stagehandArg = vi.mocked(Stagehand).mock.calls.at(-1)?.[0] as {
      logger?: (line: StagehandLogLine) => void;
    };
    const loggerCallback = stagehandArg.logger;
    expect(loggerCallback).toBeInstanceOf(Function);

    loggerCallback?.({ category: "action", message: "clicked element", level: 1 });

    expect(loggerStub.info).toHaveBeenCalledWith({ stagehand: "action" }, "clicked element");
  });

  it("exposes a deathSignal that rejects when the logger callback observes a teardown line", async () => {
    const session = await createSteelBrowserSession();

    const stagehandArg = vi.mocked(Stagehand).mock.calls.at(-1)?.[0] as {
      logger?: (line: StagehandLogLine) => void;
    };
    const loggerCallback = stagehandArg.logger;
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
});

describe("scraper/session-steel CDP-transport-teardown detection", () => {
  beforeEach(() => {
    configRef.value.scraper.steelApiKey = "steel-key";
    configRef.value.scraper.anthropicApiKey = "anthropic-key";
    configRef.value.scraper.useBedrock = false;
    vi.clearAllMocks();
  });

  it("flags an SDK-initiated transport close that happens before our own close()", async () => {
    const session = await createSteelBrowserSession();
    const handler = fakeConn.onTransportClosed.mock.calls[0]?.[0] as (why: string) => void;

    handler("socket-close code=1006 reason=");

    const err = session.getCdpTransportClosedError?.();
    expect(err).toBeDefined();
    expect(isCdpTransportClosedError(err)).toBe(true);
    expect(err?.message).toContain("socket-close code=1006 reason=");
  });

  it("does not flag a transport close that happens as a consequence of our own close()", async () => {
    const session = await createSteelBrowserSession();
    const handler = fakeConn.onTransportClosed.mock.calls[0]?.[0] as (why: string) => void;

    await session.close();
    handler("socket-close code=1000 reason=normal-close");

    expect(session.getCdpTransportClosedError?.()).toBeUndefined();
  });
});
