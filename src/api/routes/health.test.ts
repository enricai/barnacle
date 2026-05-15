import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type HealthConfig, healthRoutes } from "@/api/routes/health";
import { prisma } from "@/lib/db/client";

/**
 * The readiness probe is the single source of truth ops uses to route
 * traffic away from a pod. Tests cover the happy path (every dep ok →
 * 200 + "ready") and the two degradation modes (missing scraper creds,
 * DB unreachable → 503 + "degraded" with per-check detail).
 *
 * Config is injected through the plugin options, so each test builds a
 * small Fastify instance with exactly the state it wants — no env-var
 * gymnastics, no frozen-config redefinition hacks.
 */

vi.mock("@/lib/db/client", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
  },
}));

function makeConfig(overrides: Partial<HealthConfig> = {}): HealthConfig {
  const scraperDefaults = {
    steelApiKey: "test-steel",
    anthropicApiKey: "test-anthropic",
    readinessQueueThreshold: 20,
    useBedrock: false,
  };
  return {
    databaseUrl: overrides.databaseUrl,
    scraper: { ...scraperDefaults, ...(overrides.scraper ?? {}) },
    bedrock: overrides.bedrock ?? {
      accessKeyId: undefined,
      secretAccessKey: undefined,
      region: "us-east-1",
    },
  };
}

function makePoolStats(
  size = 0,
  pending = 0
): () => {
  size: number;
  pending: number;
  concurrency: number;
} {
  return () => ({ size, pending, concurrency: 3 });
}

function makeCacheStats(
  overrides: Partial<{ size: number; max: number; inFlight: number }> = {}
): () => { size: number; max: number; inFlight: number } {
  return () => ({
    size: overrides.size ?? 0,
    max: overrides.max ?? 1000,
    inFlight: overrides.inFlight ?? 0,
  });
}

async function buildHealthApp(
  config: HealthConfig,
  poolStats = makePoolStats(),
  cacheStats = makeCacheStats()
) {
  const app = Fastify();
  await app.register(healthRoutes, { config, poolStats, cacheStats });
  await app.ready();
  return app;
}

describe("routes/health /readyz", () => {
  beforeEach(() => {
    vi.mocked(prisma.$queryRawUnsafe).mockReset();
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([{ "?column?": 1 }]);
  });

  it("returns 200 + 'ready' when all deps are healthy and DB is skipped", async () => {
    const app = await buildHealthApp(makeConfig());
    try {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        status: string;
        checks: { database: { ok: boolean }; scraperCredentials: { ok: boolean } };
      };
      expect(body.status).toBe("ready");
      expect(body.checks.database.ok).toBe(true);
      expect(body.checks.scraperCredentials.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns 200 + 'ready' when DB is configured and reachable", async () => {
    const app = await buildHealthApp(makeConfig({ databaseUrl: "postgres://ok:5432/db" }));
    try {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(200);
      expect(vi.mocked(prisma.$queryRawUnsafe)).toHaveBeenCalledWith("SELECT 1");
    } finally {
      await app.close();
    }
  });

  it("returns 503 + 'degraded' when scraper credentials are missing", async () => {
    const app = await buildHealthApp(
      makeConfig({
        scraper: {
          steelApiKey: undefined,
          anthropicApiKey: undefined,
          readinessQueueThreshold: 20,
          useBedrock: false,
        },
      })
    );
    try {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json() as {
        status: string;
        checks: { scraperCredentials: { ok: boolean; detail?: string } };
      };
      expect(body.status).toBe("degraded");
      expect(body.checks.scraperCredentials.ok).toBe(false);
      expect(body.checks.scraperCredentials.detail).toContain("STEEL_API_KEY");
      expect(body.checks.scraperCredentials.detail).toContain("ANTHROPIC_API_KEY");
    } finally {
      await app.close();
    }
  });

  it("returns 503 + 'degraded' when the database is unreachable", async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const app = await buildHealthApp(makeConfig({ databaseUrl: "postgres://unreachable:5432/db" }));
    try {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json() as {
        status: string;
        checks: { database: { ok: boolean; detail?: string } };
      };
      expect(body.status).toBe("degraded");
      expect(body.checks.database.ok).toBe(false);
      expect(body.checks.database.detail).toContain("ECONNREFUSED");
    } finally {
      await app.close();
    }
  });

  it("returns 503 + 'degraded' when scraper queue depth exceeds threshold", async () => {
    const app = await buildHealthApp(
      makeConfig({
        scraper: {
          steelApiKey: "test-steel",
          anthropicApiKey: "test-anthropic",
          readinessQueueThreshold: 5,
          useBedrock: false,
        },
      }),
      makePoolStats(10, 3) // depth 13 > threshold 5
    );
    try {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json() as {
        status: string;
        checks: { scraperPool: { ok: boolean; detail?: string } };
      };
      expect(body.status).toBe("degraded");
      expect(body.checks.scraperPool.ok).toBe(false);
      expect(body.checks.scraperPool.detail).toContain("13");
      expect(body.checks.scraperPool.detail).toContain("5");
    } finally {
      await app.close();
    }
  });

  it("keeps scraperPool 'ok' at exactly the threshold (inclusive)", async () => {
    const app = await buildHealthApp(
      makeConfig({
        scraper: {
          steelApiKey: "test-steel",
          anthropicApiKey: "test-anthropic",
          readinessQueueThreshold: 5,
          useBedrock: false,
        },
      }),
      makePoolStats(3, 2) // depth 5 == threshold
    );
    try {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        checks: { scraperPool: { ok: boolean; detail?: string } };
      };
      expect(body.checks.scraperPool.ok).toBe(true);
      expect(body.checks.scraperPool.detail).toContain("depth=5");
    } finally {
      await app.close();
    }
  });

  it("/healthz stays a pure liveness probe with 200 + {status:'ok'}", async () => {
    const app = await buildHealthApp(makeConfig());
    try {
      const response = await app.inject({ method: "GET", url: "/healthz" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });

  it("returns 200 when useBedrock=true and no explicit AWS keys (ambient IAM assumed)", async () => {
    const app = await buildHealthApp(
      makeConfig({
        scraper: {
          steelApiKey: "test-steel",
          anthropicApiKey: undefined,
          readinessQueueThreshold: 20,
          useBedrock: true,
        },
        bedrock: { accessKeyId: undefined, secretAccessKey: undefined, region: "us-east-1" },
      })
    );
    try {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { checks: { scraperCredentials: { ok: boolean } } };
      expect(body.checks.scraperCredentials.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns 503 when useBedrock=true and only accessKeyId is set", async () => {
    const app = await buildHealthApp(
      makeConfig({
        scraper: {
          steelApiKey: "test-steel",
          anthropicApiKey: undefined,
          readinessQueueThreshold: 20,
          useBedrock: true,
        },
        bedrock: { accessKeyId: "AKIA...", secretAccessKey: undefined, region: "us-east-1" },
      })
    );
    try {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json() as {
        checks: { scraperCredentials: { ok: boolean; detail?: string } };
      };
      expect(body.checks.scraperCredentials.ok).toBe(false);
      expect(body.checks.scraperCredentials.detail).toContain("AWS_SECRET_ACCESS_KEY");
    } finally {
      await app.close();
    }
  });

  it("returns 503 when useBedrock=true and only secretAccessKey is set", async () => {
    const app = await buildHealthApp(
      makeConfig({
        scraper: {
          steelApiKey: "test-steel",
          anthropicApiKey: undefined,
          readinessQueueThreshold: 20,
          useBedrock: true,
        },
        bedrock: { accessKeyId: undefined, secretAccessKey: "secret", region: "us-east-1" },
      })
    );
    try {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json() as {
        checks: { scraperCredentials: { ok: boolean; detail?: string } };
      };
      expect(body.checks.scraperCredentials.ok).toBe(false);
      expect(body.checks.scraperCredentials.detail).toContain("AWS_ACCESS_KEY_ID");
    } finally {
      await app.close();
    }
  });

  it("returns 503 when useBedrock=false and ANTHROPIC_API_KEY is missing (regression guard)", async () => {
    const app = await buildHealthApp(
      makeConfig({
        scraper: {
          steelApiKey: "test-steel",
          anthropicApiKey: undefined,
          readinessQueueThreshold: 20,
          useBedrock: false,
        },
      })
    );
    try {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json() as {
        checks: { scraperCredentials: { ok: boolean; detail?: string } };
      };
      expect(body.checks.scraperCredentials.ok).toBe(false);
      expect(body.checks.scraperCredentials.detail).toContain("ANTHROPIC_API_KEY");
    } finally {
      await app.close();
    }
  });

  it("/readyz includes scraperPool + cache stats for ops dashboards", async () => {
    const app = await buildHealthApp(
      makeConfig(),
      makePoolStats(3, 2),
      makeCacheStats({ size: 42, inFlight: 1 })
    );
    try {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      const body = response.json() as {
        stats: {
          scraperPool: { size: number; pending: number; concurrency: number };
          cache: { size: number; max: number; inFlight: number };
        };
      };
      expect(body.stats.scraperPool).toEqual({ size: 3, pending: 2, concurrency: 3 });
      expect(body.stats.cache.size).toBe(42);
      expect(body.stats.cache.max).toBe(1000);
      expect(body.stats.cache.inFlight).toBe(1);
    } finally {
      await app.close();
    }
  });
});
