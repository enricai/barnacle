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
    process.env.BARNACLE_SITE_EXAMPLE_BASE_URL = "https://test.example.com";
    process.env.BARNACLE_SITE_IGNORED = "should-not-appear";
    const cfg = loadConfig();
    expect(cfg.scraper.siteBaseUrls["my-shop"]).toBe("https://staging.my-shop.com");
    expect(cfg.scraper.siteBaseUrls.example).toBe("https://test.example.com");
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
});
