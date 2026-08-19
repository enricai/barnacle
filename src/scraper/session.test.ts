/**
 * Tests for the provider-selection router in src/scraper/session.ts and the
 * required-key validation in each per-provider builder. We never hit Steel or
 * Browserbase — the underlying Stagehand/Steel imports are mocked at the
 * module boundary, so the only behaviors exercised are config wiring and the
 * pre-flight guard clauses.
 */

import { Stagehand } from "@browserbasehq/stagehand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserSession } from "@/scraper/session";
import { createBrowserbaseBrowserSession } from "@/scraper/session-browserbase";
import { createSteelBrowserSession } from "@/scraper/session-steel";

const { configRef } = vi.hoisted(() => ({
  configRef: {
    value: {
      scraper: {
        provider: "browserbase" as "browserbase" | "steel",
        browserbaseApiKey: "bb-key" as string | undefined,
        browserbaseProjectId: "bb-project" as string | undefined,
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

vi.mock("@browserbasehq/stagehand", () => ({
  AISdkClient: vi.fn(),
  Stagehand: vi.fn(function (this: Record<string, unknown>) {
    this.init = vi.fn().mockResolvedValue(undefined);
    this.close = vi.fn().mockResolvedValue(undefined);
    this.browserbaseSessionID = "bb-session-id";
    this.context = { conn: { send: vi.fn().mockResolvedValue(undefined) } };
  }),
}));

vi.mock("@/scraper/cdp-heartbeat", () => ({
  startCdpTransportHeartbeat: vi.fn(() => ({ stop: vi.fn() })),
}));

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
  getScriptLogger: () => loggerStub,
}));

vi.mock("@/scraper/throttle", () => ({
  createSessionLimiter: vi.fn(() => ({
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

const { resolveSessionOutboundIp } = vi.hoisted(() => ({
  resolveSessionOutboundIp: vi.fn(),
}));

vi.mock("@/scraper/session-ip", () => ({
  resolveSessionOutboundIp,
}));

const defaultConfig = (): typeof configRef.value => ({
  scraper: {
    provider: "browserbase",
    browserbaseApiKey: "bb-key",
    browserbaseProjectId: "bb-project",
    steelApiKey: "steel-key",
    anthropicApiKey: "anthropic-key",
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
});

describe("scraper/session router", () => {
  beforeEach(() => {
    configRef.value = defaultConfig();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses config.scraper.provider when no opts.provider is passed", async () => {
    configRef.value.scraper.provider = "browserbase";
    const session = await createBrowserSession();
    expect(session.provider).toBe("browserbase");
  });

  it("opts.provider overrides config.scraper.provider", async () => {
    configRef.value.scraper.provider = "browserbase";
    const session = await createBrowserSession({ provider: "steel" });
    expect(session.provider).toBe("steel");
  });

  it("routes to steel when both config and opts agree on steel", async () => {
    configRef.value.scraper.provider = "steel";
    const session = await createBrowserSession({ provider: "steel" });
    expect(session.provider).toBe("steel");
  });
});

describe("scraper/session-browserbase required-key validation", () => {
  beforeEach(() => {
    configRef.value = defaultConfig();
  });

  it("throws when BROWSERBASE_API_KEY is missing", async () => {
    configRef.value.scraper.browserbaseApiKey = undefined;
    await expect(createBrowserbaseBrowserSession()).rejects.toThrow(/BROWSERBASE_API_KEY/);
  });

  it("throws when BROWSERBASE_PROJECT_ID is missing", async () => {
    configRef.value.scraper.browserbaseProjectId = undefined;
    await expect(createBrowserbaseBrowserSession()).rejects.toThrow(/BROWSERBASE_PROJECT_ID/);
  });

  it("throws when ANTHROPIC_API_KEY is missing and bedrock is not enabled", async () => {
    configRef.value.scraper.anthropicApiKey = undefined;
    configRef.value.scraper.useBedrock = false;
    await expect(createBrowserbaseBrowserSession()).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("forwards custom Browserbase session params while preserving managed settings", async () => {
    await createBrowserbaseBrowserSession({
      advancedStealth: true,
      browserbaseSessionCreateParams: {
        timeout: 300,
        projectId: "caller-project",
        proxies: false,
        browserSettings: { locale: "en-US" },
      },
    });

    const stagehandArg = vi.mocked(Stagehand).mock.calls.at(-1)?.[0] as {
      browserbaseSessionCreateParams: {
        projectId: string;
        proxies: boolean;
        timeout?: number;
        browserSettings: Record<string, unknown>;
      };
    };

    expect(stagehandArg.browserbaseSessionCreateParams).toEqual(
      expect.objectContaining({
        projectId: "bb-project",
        proxies: true,
        timeout: 300,
      })
    );
    expect(stagehandArg.browserbaseSessionCreateParams.browserSettings).toEqual(
      expect.objectContaining({
        locale: "en-US",
        advancedStealth: true,
        solveCaptchas: true,
        fingerprint: expect.objectContaining({
          devices: ["desktop"],
          operatingSystems: ["windows"],
        }),
      })
    );
  });

  it("passes keepAlive:true so Stagehand's out-of-process shutdown supervisor never spawns", async () => {
    await createBrowserbaseBrowserSession();

    const stagehandArg = vi.mocked(Stagehand).mock.calls.at(-1)?.[0] as { keepAlive?: boolean };

    expect(stagehandArg.keepAlive).toBe(true);
  });
});

describe("scraper/session-steel required-key validation", () => {
  beforeEach(() => {
    configRef.value = defaultConfig();
  });

  it("throws when STEEL_API_KEY is missing", async () => {
    configRef.value.scraper.steelApiKey = undefined;
    await expect(createSteelBrowserSession()).rejects.toThrow(/STEEL_API_KEY/);
  });

  it("throws when ANTHROPIC_API_KEY is missing and bedrock is not enabled", async () => {
    configRef.value.scraper.anthropicApiKey = undefined;
    configRef.value.scraper.useBedrock = false;
    await expect(createSteelBrowserSession()).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("passes keepAlive:true so Stagehand's out-of-process shutdown supervisor never spawns", async () => {
    await createSteelBrowserSession();

    const stagehandArg = vi.mocked(Stagehand).mock.calls.at(-1)?.[0] as { keepAlive?: boolean };

    expect(stagehandArg.keepAlive).toBe(true);
  });
});

describe("BrowserSession.getOutboundIp", () => {
  beforeEach(() => {
    configRef.value = defaultConfig();
    resolveSessionOutboundIp.mockReset();
  });

  it("is exposed on a Browserbase session returned by createBrowserbaseBrowserSession", async () => {
    resolveSessionOutboundIp.mockResolvedValue("203.0.113.7");
    const session = await createBrowserbaseBrowserSession();
    expect(session.getOutboundIp).toBeTypeOf("function");
  });

  it("is absent on a Steel session — the field stays optional on BrowserSession", async () => {
    const session = await createSteelBrowserSession();
    expect(session.getOutboundIp).toBeUndefined();
  });

  it("invokes resolveSessionOutboundIp exactly once across N sequential calls", async () => {
    resolveSessionOutboundIp.mockResolvedValue("203.0.113.7");
    const session = await createBrowserbaseBrowserSession();

    const first = await session.getOutboundIp?.();
    const second = await session.getOutboundIp?.();
    const third = await session.getOutboundIp?.();

    expect(first).toBe("203.0.113.7");
    expect(second).toBe("203.0.113.7");
    expect(third).toBe("203.0.113.7");
    expect(resolveSessionOutboundIp).toHaveBeenCalledOnce();
  });

  it("invokes resolveSessionOutboundIp exactly once across N concurrent calls (in-flight-promise race)", async () => {
    resolveSessionOutboundIp.mockResolvedValue("203.0.113.7");
    const session = await createBrowserbaseBrowserSession();

    const results = await Promise.all([
      session.getOutboundIp?.(),
      session.getOutboundIp?.(),
      session.getOutboundIp?.(),
    ]);

    expect(results).toEqual(["203.0.113.7", "203.0.113.7", "203.0.113.7"]);
    expect(resolveSessionOutboundIp).toHaveBeenCalledOnce();
  });

  it("memoizes a null resolution too, per the accessor's TSDoc contract", async () => {
    resolveSessionOutboundIp.mockResolvedValue(null);
    const session = await createBrowserbaseBrowserSession();

    expect(await session.getOutboundIp?.()).toBeNull();
    expect(await session.getOutboundIp?.()).toBeNull();
    expect(resolveSessionOutboundIp).toHaveBeenCalledOnce();
  });

  it("threads config.scraper.captureSessionIp=false through to the accessor: returns null, never invokes the resolver", async () => {
    configRef.value.scraper.captureSessionIp = false;
    resolveSessionOutboundIp.mockResolvedValue("203.0.113.7");
    const session = await createBrowserbaseBrowserSession();

    expect(await session.getOutboundIp?.()).toBeNull();
    expect(await session.getOutboundIp?.()).toBeNull();
    expect(resolveSessionOutboundIp).not.toHaveBeenCalled();
  });
});
