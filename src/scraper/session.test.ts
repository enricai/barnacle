/**
 * Tests for the provider-selection router in src/scraper/session.ts and the
 * required-key validation in each per-provider builder. We never hit Steel or
 * Browserbase — the underlying Stagehand/Steel imports are mocked at the
 * module boundary, so the only behaviors exercised are config wiring and the
 * pre-flight guard clauses.
 */
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
      },
      bedrock: { region: "us-east-1", model: "test", accessKeyId: undefined, secretAccessKey: undefined, sessionToken: undefined },
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
  Stagehand: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    browserbaseSessionID: "bb-session-id",
  })),
}));

vi.mock("steel-sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    sessions: {
      create: vi.fn().mockResolvedValue({
        id: "steel-session-id",
        websocketUrl: "wss://connect.steel.dev?sessionId=steel-session-id",
      }),
      release: vi.fn().mockResolvedValue(undefined),
    },
  })),
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
  },
  bedrock: { region: "us-east-1", model: "test", accessKeyId: undefined, secretAccessKey: undefined, sessionToken: undefined },
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
});
