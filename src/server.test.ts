import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILTIN_SITE_PLUGINS } from "@/plugins/discover";
import type { SitePlugin } from "@/site-plugin";

interface LoggerStub {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  fatal: ReturnType<typeof vi.fn>;
  trace: ReturnType<typeof vi.fn>;
  errorWithStack: ReturnType<typeof vi.fn>;
  child: () => LoggerStub;
}

// vi.hoisted runs before vi.mock factories — required so these references
// are available when the factory closures execute.
const mockDrainPool = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDrainTrackingClicks = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockShutdownStatsD = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockShutdownS3Sink = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
// Fastify's loggerInstance validation requires the full pino method set
// (info/error/debug/fatal/warn/trace/child) — a bare {warn: vi.fn()} stub
// fails FST_ERR_LOG_INVALID_LOGGER, so `child()` must return a compatible
// logger too since Fastify calls it per-request.
const { loggerStub } = vi.hoisted(() => {
  const makeStub = (): LoggerStub => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    errorWithStack: vi.fn(),
    child: () => makeStub(),
  });
  return { loggerStub: makeStub() };
});

// Stub the engine's own drains so tests don't touch a real queue, socket,
// or S3 sink — precedent: loader.test.ts mocks @/scraper/pool and
// @/lib/tracking-click the same way. importOriginal keeps each module's
// other exports (poolStats, runWithSession, etc.) real since buildServer's
// health routes depend on them.
vi.mock("@/scraper/pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/pool")>();
  return { ...actual, drainPool: mockDrainPool };
});

vi.mock("@/lib/tracking-click", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tracking-click")>();
  return { ...actual, drainTrackingClicks: mockDrainTrackingClicks };
});

vi.mock("@/lib/statsd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/statsd")>();
  return { ...actual, shutdownStatsD: mockShutdownStatsD };
});

vi.mock("@/lib/telemetry/s3-sink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telemetry/s3-sink")>();
  return { ...actual, shutdownS3Sink: mockShutdownS3Sink, startS3SinkTimer: vi.fn() };
});

// server.ts's module-level `logger` is created once via getLogger at
// import time — stubbing here lets tests assert on its warn calls,
// which app.log (Fastify's own logger) does not observe. Only getLogger
// is overridden (importOriginal keeps getScriptLogger etc. real) since
// transitively imported modules (e.g. scraper/flow-runner.ts) need them.
vi.mock("@/lib/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging")>();
  return { ...actual, getLogger: () => loggerStub };
});

/**
 * `buildServer()` registers an `onClose` hook that drains each loaded
 * plugin's `onShutdown` alongside the engine's own drains. `BUILTIN_SITE_PLUGINS`
 * is a mutable array kept exactly so tests can push a fixture plugin without
 * threading `BARNACLE_PLUGINS` through env vars — see discover.test.ts.
 */
function pushFixturePlugin(plugin: SitePlugin<unknown, unknown>): () => void {
  const originalLength = BUILTIN_SITE_PLUGINS.length;
  BUILTIN_SITE_PLUGINS.push(plugin);
  return () => {
    BUILTIN_SITE_PLUGINS.length = originalLength;
  };
}

async function makeFixturePlugin(
  siteId: string,
  onShutdown?: () => Promise<void>
): Promise<SitePlugin<unknown, unknown>> {
  const { z } = await import("zod/v4");
  return {
    meta: {
      siteId,
      displayName: siteId,
      bodySchema: z.object({}),
      responseSchema: z.object({}),
      onShutdown,
    },
    execute: async () => ({ data: {} }),
  } as unknown as SitePlugin<unknown, unknown>;
}

describe("buildServer onClose plugin drain", () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    // Restore in reverse (LIFO) order: each restore's captured originalLength
    // is relative to the array state at push time, so restoring out of order
    // leaves a hole instead of an empty array.
    for (const restore of restores.splice(0).reverse()) restore();
    vi.restoreAllMocks();
    mockDrainPool.mockClear();
    mockDrainTrackingClicks.mockClear();
    mockShutdownStatsD.mockClear();
    mockShutdownS3Sink.mockClear();
    loggerStub.warn.mockClear();
  });

  it("awaits a loaded plugin's onShutdown on app.close(), before shutdownStatsD/shutdownS3Sink", async () => {
    const callOrder: string[] = [];
    const onShutdown = vi.fn().mockImplementation(async () => {
      callOrder.push("plugin");
    });
    mockShutdownStatsD.mockImplementationOnce(async () => {
      callOrder.push("shutdownStatsD");
    });
    mockShutdownS3Sink.mockImplementationOnce(async () => {
      callOrder.push("shutdownS3Sink");
    });
    restores.push(pushFixturePlugin(await makeFixturePlugin("fixture-drain", onShutdown)));

    const { buildServer } = await import("@/server.js");
    const app = await buildServer();
    await app.close();

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["plugin", "shutdownStatsD", "shutdownS3Sink"]);
  });

  it("a throwing plugin's onShutdown does not block another plugin's drain", async () => {
    const failingShutdown = vi.fn().mockRejectedValue(new Error("boom"));
    const healthyShutdown = vi.fn().mockResolvedValue(undefined);
    restores.push(pushFixturePlugin(await makeFixturePlugin("fixture-throws", failingShutdown)));
    restores.push(pushFixturePlugin(await makeFixturePlugin("fixture-healthy", healthyShutdown)));

    const { buildServer } = await import("@/server.js");
    const app = await buildServer();
    await expect(app.close()).resolves.toBeUndefined();

    expect(failingShutdown).toHaveBeenCalledTimes(1);
    expect(healthyShutdown).toHaveBeenCalledTimes(1);
  });

  it("a plugin with no onShutdown is unaffected and does not warn", async () => {
    restores.push(pushFixturePlugin(await makeFixturePlugin("fixture-no-shutdown")));

    const { buildServer } = await import("@/server.js");
    const app = await buildServer();
    await expect(app.close()).resolves.toBeUndefined();

    const shutdownWarnings = loggerStub.warn.mock.calls.filter(([msg]) =>
      String(msg).includes("shutdown")
    );
    expect(shutdownWarnings).toHaveLength(0);
  });
});
