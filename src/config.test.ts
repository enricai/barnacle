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
    expect(cfg.scraper.httpTimeoutMs).toBe(20_000);
    expect(cfg.scraper.model).toBe("anthropic/claude-sonnet-4-6");
    // Default trustProxy=true matches the most common deploy shape
    // (behind an ALB/nginx/Cloudflare); bare-metal runners must opt out.
    expect(cfg.trustProxy).toBe(true);
    expect(cfg.cache.ttlMs).toBe(15 * 60 * 1000);
    expect(cfg.workers.enabled).toBe(false);
    expect(cfg.docs.enabled).toBe(false);
  });

  it("parses numeric env vars as numbers", () => {
    process.env.PORT = "4321";
    process.env.SESSION_POOL_SIZE = "10";
    process.env.RATE_LIMIT_MAX = "500";
    process.env.SCRAPER_HTTP_TIMEOUT_MS = "45000";
    const cfg = loadConfig();
    expect(cfg.port).toBe(4321);
    expect(cfg.scraper.poolSize).toBe(10);
    expect(cfg.rateLimit.max).toBe(500);
    expect(cfg.scraper.httpTimeoutMs).toBe(45_000);
  });

  it("parses boolean env vars", () => {
    process.env.ENABLE_DOCS = "true";
    process.env.ENABLE_WORKERS = "1";
    process.env.DEV_BYPASS_AUTH = "yes";
    process.env.TRUST_PROXY = "false";
    const cfg = loadConfig();
    expect(cfg.docs.enabled).toBe(true);
    expect(cfg.workers.enabled).toBe(true);
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

  it("returned object is frozen", () => {
    const cfg = loadConfig();
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});
