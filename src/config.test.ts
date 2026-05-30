import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "@/config";

/**
 * loadConfig is idempotent per call — it reads process.env each time.
 * Tests manipulate env in a save/restore pattern so values don't leak.
 */
describe("config/loadConfig", () => {
  const snapshot = { ...process.env };

  beforeEach(() => {
    process.env = { ...snapshot };
  });

  afterEach(() => {
    process.env = { ...snapshot };
  });

  it("returns sensible defaults when env is empty", () => {
    process.env = {};
    const cfg = loadConfig();
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(3000);
    expect(cfg.scraper.poolSize).toBe(3);
    expect(cfg.scraper.solveCaptcha).toBe(true);
    expect(cfg.scraper.readinessQueueThreshold).toBe(20);
    expect(cfg.scraper.siteBaseUrls).toEqual({});
    expect(cfg.scraper.model).toBe("anthropic/claude-sonnet-4-6");
    expect(cfg.scraper.anthropicTimeoutMs).toBe(120_000);
    // Default trustProxy=true matches the most common deploy shape
    // (behind an ALB/nginx/Cloudflare); bare-metal runners must opt out.
    expect(cfg.trustProxy).toBe(true);
    expect(cfg.cache.ttlMs).toBe(15 * 60 * 1000);
    expect(cfg.docs.enabled).toBe(false);
  });

  it("parses numeric env vars as numbers", () => {
    process.env.PORT = "4321";
    process.env.SESSION_POOL_SIZE = "10";
    process.env.RATE_LIMIT_MAX = "500";
    process.env.STAGEHAND_API_TIMEOUT_MS = "30000";
    const cfg = loadConfig();
    expect(cfg.port).toBe(4321);
    expect(cfg.scraper.poolSize).toBe(10);
    expect(cfg.rateLimit.max).toBe(500);
    expect(cfg.scraper.anthropicTimeoutMs).toBe(30000);
  });

  it("parses boolean env vars", () => {
    process.env.ENABLE_DOCS = "true";
    process.env.DEV_BYPASS_AUTH = "yes";
    process.env.TRUST_PROXY = "false";
    const cfg = loadConfig();
    expect(cfg.docs.enabled).toBe(true);
    expect(cfg.auth.devBypass).toBe(true);
    // TRUST_PROXY=false is the bare-metal setting — flip it off so
    // X-Forwarded-For spoofing can't bypass IP-based rate limiting.
    expect(cfg.trustProxy).toBe(false);
  });

  it("splits comma-separated API_KEYS_HASHED", () => {
    process.env.API_KEYS_HASHED = "hashA,hashB, hashC ";
    const cfg = loadConfig();
    expect(cfg.auth.hashedKeys).toEqual(["hashA", "hashB", "hashC"]);
  });

  it("returns an empty key list when API_KEYS_HASHED is empty", () => {
    process.env.API_KEYS_HASHED = "";
    const cfg = loadConfig();
    expect(cfg.auth.hashedKeys).toEqual([]);
  });

  it("bedrock defaults when USE_BEDROCK is unset", () => {
    process.env = {};
    const cfg = loadConfig();
    expect(cfg.scraper.useBedrock).toBe(false);
    expect(cfg.bedrock.region).toBe("us-east-1");
    expect(cfg.bedrock.model).toBe("us.anthropic.claude-sonnet-4-6[1m]");
    expect(cfg.bedrock.accessKeyId).toBeUndefined();
    expect(cfg.bedrock.secretAccessKey).toBeUndefined();
    expect(cfg.bedrock.sessionToken).toBeUndefined();
  });

  it("populates siteBaseUrls from BARNACLE_SITE_*_BASE_URL env vars", () => {
    process.env.BARNACLE_SITE_MY_SHOP_BASE_URL = "https://staging.my-shop.com";
    process.env.BARNACLE_SITE_ANOTHER_SHOP_BASE_URL = "https://test.another-shop.com";
    process.env.BARNACLE_SITE_IGNORED = "should-not-appear";
    const cfg = loadConfig();
    expect(cfg.scraper.siteBaseUrls["my-shop"]).toBe("https://staging.my-shop.com");
    expect(cfg.scraper.siteBaseUrls["another-shop"]).toBe("https://test.another-shop.com");
    expect(Object.keys(cfg.scraper.siteBaseUrls)).not.toContain("ignored");
  });

  it("normalizes empty-string AWS credentials to undefined", () => {
    process.env.USE_BEDROCK = "true";
    process.env.AWS_ACCESS_KEY_ID = "";
    process.env.AWS_SECRET_ACCESS_KEY = "";
    process.env.AWS_SESSION_TOKEN = "";
    const cfg = loadConfig();
    expect(cfg.bedrock.accessKeyId).toBeUndefined();
    expect(cfg.bedrock.secretAccessKey).toBeUndefined();
    expect(cfg.bedrock.sessionToken).toBeUndefined();
  });

  it("bedrock config is populated when USE_BEDROCK=true", () => {
    process.env.USE_BEDROCK = "true";
    process.env.AWS_REGION = "us-west-2";
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    process.env.AWS_SESSION_TOKEN = "token";
    process.env.BEDROCK_MODEL = "us.anthropic.claude-opus-4-7[1m]";
    const cfg = loadConfig();
    expect(cfg.scraper.useBedrock).toBe(true);
    expect(cfg.bedrock.region).toBe("us-west-2");
    expect(cfg.bedrock.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(cfg.bedrock.secretAccessKey).toBe("secret");
    expect(cfg.bedrock.sessionToken).toBe("token");
    expect(cfg.bedrock.model).toBe("us.anthropic.claude-opus-4-7[1m]");
  });

  it("telemetry defaults", () => {
    process.env = {};
    const cfg = loadConfig();
    expect(cfg.telemetry.enabled).toBe(true);
    expect(cfg.telemetry.eventsDir).toBe(".barnacle/events");
    expect(cfg.telemetry.callsNdjsonPath).toBe(".barnacle/calls.ndjson");
    // 100 MB default guards against unbounded growth
    expect(cfg.telemetry.maxFileSizeBytes).toBe(100 * 1024 * 1024);
    // 30-day retention covers a monthly judge/heal cadence
    expect(cfg.telemetry.maxRetentionMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("telemetry env overrides", () => {
    process.env.TELEMETRY_ENABLED = "false";
    process.env.TELEMETRY_EVENTS_DIR = "/data/events";
    process.env.CALLS_NDJSON_PATH = "/data/calls.ndjson";
    process.env.TELEMETRY_MAX_FILE_SIZE_BYTES = "52428800";
    process.env.TELEMETRY_MAX_RETENTION_MS = "86400000";
    const cfg = loadConfig();
    expect(cfg.telemetry.enabled).toBe(false);
    expect(cfg.telemetry.eventsDir).toBe("/data/events");
    expect(cfg.telemetry.callsNdjsonPath).toBe("/data/calls.ndjson");
    expect(cfg.telemetry.maxFileSizeBytes).toBe(52428800);
    expect(cfg.telemetry.maxRetentionMs).toBe(86400000);
  });

  it("judging defaults", () => {
    process.env = {};
    const cfg = loadConfig();
    expect(cfg.judging.model).toBe("us.anthropic.claude-sonnet-4-6[1m]");
    // Low temperature for deterministic verdicts
    expect(cfg.judging.temperature).toBe(0.2);
    expect(cfg.judging.batchSize).toBe(10);
    expect(cfg.judging.timeoutMs).toBe(120_000);
  });

  it("judging env overrides", () => {
    process.env.JUDGE_MODEL = "us.anthropic.claude-opus-4-8[1m]";
    process.env.JUDGE_TEMPERATURE = "0.5";
    process.env.JUDGE_BATCH_SIZE = "20";
    process.env.JUDGE_TIMEOUT_MS = "60000";
    const cfg = loadConfig();
    expect(cfg.judging.model).toBe("us.anthropic.claude-opus-4-8[1m]");
    expect(cfg.judging.temperature).toBe(0.5);
    expect(cfg.judging.batchSize).toBe(20);
    expect(cfg.judging.timeoutMs).toBe(60000);
  });

  it("selfheal defaults", () => {
    process.env = {};
    const cfg = loadConfig();
    expect(cfg.selfheal.maxIterations).toBe(5);
    expect(cfg.selfheal.nReplays).toBe(5);
    // 0.9 success threshold mirrors pila llm-self-heal SKILL default
    expect(cfg.selfheal.successThreshold).toBe(0.9);
    expect(cfg.selfheal.plateauWindow).toBe(3);
    expect(cfg.selfheal.plateauDelta).toBe(0.03);
    expect(cfg.selfheal.timeoutMs).toBe(60_000);
  });

  it("selfheal env overrides", () => {
    process.env.SELFHEAL_MAX_ITERATIONS = "10";
    process.env.SELFHEAL_N_REPLAYS = "8";
    process.env.SELFHEAL_SUCCESS_THRESHOLD = "0.95";
    process.env.SELFHEAL_PLATEAU_WINDOW = "5";
    process.env.SELFHEAL_PLATEAU_DELTA = "0.05";
    process.env.SELFHEAL_TIMEOUT_MS = "30000";
    const cfg = loadConfig();
    expect(cfg.selfheal.maxIterations).toBe(10);
    expect(cfg.selfheal.nReplays).toBe(8);
    expect(cfg.selfheal.successThreshold).toBe(0.95);
    expect(cfg.selfheal.plateauWindow).toBe(5);
    expect(cfg.selfheal.plateauDelta).toBe(0.05);
    expect(cfg.selfheal.timeoutMs).toBe(30000);
  });
});
