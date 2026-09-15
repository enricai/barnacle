/**
 * Unit tests for the DogStatsD client singleton. `getStatsD()` memoizes at
 * module scope, so every test resets modules and dynamically re-imports to
 * get a fresh singleton, and `hot-shots` resolution is stubbed via a mocked
 * `createRequire` since the module resolves it lazily through `node:module`
 * rather than a static import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const ORIGINAL_ENV = { ...process.env };

describe("statsd", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns a no-op client when DD_METRICS_ENABLED is unset", async () => {
    delete process.env.DD_METRICS_ENABLED;
    const { getStatsD } = await import("@/lib/statsd.js");

    const client = getStatsD();

    expect(() => client.increment("test.metric")).not.toThrow();
    expect(() => client.timing("test.metric", 100)).not.toThrow();
    await expect(
      new Promise<void>((resolve, reject) => {
        client.close((err?: Error) => (err ? reject(err) : resolve()));
      })
    ).resolves.toBeUndefined();
  });

  it("returns a no-op client when DD_METRICS_ENABLED is false", async () => {
    process.env.DD_METRICS_ENABLED = "false";
    const { getStatsD } = await import("@/lib/statsd.js");

    const client = getStatsD();

    expect(() => client.increment("test.metric")).not.toThrow();
  });

  it("constructs a real client with prefix and configured host/port/globalTags when hot-shots is loadable", async () => {
    process.env.DD_METRICS_ENABLED = "true";
    process.env.DD_AGENT_HOST = "dd-agent.internal";
    process.env.DD_DOGSTATSD_PORT = "9125";
    process.env.DD_SERVICE = "barnacle-test";
    process.env.DD_ENV = "staging";

    const constructedOptions: Record<string, unknown>[] = [];
    class FakeStatsD {
      constructor(options: Record<string, unknown>) {
        constructedOptions.push(options);
      }
      increment(): void {}
      timing(): void {}
      close(callback: (err?: Error) => void): void {
        callback();
      }
    }

    vi.doMock("node:module", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:module")>();
      return {
        ...actual,
        createRequire: () => Object.assign(() => FakeStatsD, actual.createRequire(__filename)),
      };
    });

    const { getStatsD } = await import("@/lib/statsd.js");
    const client = getStatsD();

    expect(client).toBeInstanceOf(FakeStatsD);
    expect(constructedOptions).toHaveLength(1);
    expect(constructedOptions[0]).toMatchObject({
      host: "dd-agent.internal",
      port: 9125,
      prefix: "barnacle.",
      globalTags: {
        service: "barnacle-test",
        env: "staging",
      },
    });
  });

  it("warns and falls back to the no-op client when hot-shots fails to load", async () => {
    process.env.DD_METRICS_ENABLED = "true";

    vi.doMock("node:module", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:module")>();
      return {
        ...actual,
        createRequire: () =>
          Object.assign(() => {
            const err = new Error("Cannot find module 'hot-shots'") as NodeJS.ErrnoException;
            err.code = "MODULE_NOT_FOUND";
            throw err;
          }, actual.createRequire(__filename)),
      };
    });

    const { getStatsD } = await import("@/lib/statsd.js");
    const client = getStatsD();

    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("hot-shots is not installed")
    );
    expect(() => client.increment("test.metric")).not.toThrow();
  });

  it("memoizes the client across calls", async () => {
    delete process.env.DD_METRICS_ENABLED;
    const { getStatsD } = await import("@/lib/statsd.js");

    expect(getStatsD()).toBe(getStatsD());
  });

  it("resolves immediately when no client was ever created", async () => {
    const { shutdownStatsD } = await import("@/lib/statsd.js");

    await expect(shutdownStatsD()).resolves.toBeUndefined();
  });
});
