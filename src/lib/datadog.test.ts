import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requirePeerMock } = vi.hoisted(() => ({
  requirePeerMock: vi.fn(),
}));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: () => requirePeerMock,
  };
});

const ORIGINAL_ENV = { ...process.env };

function moduleNotFoundError(specifier: string): NodeJS.ErrnoException {
  const err = new Error(`Cannot find module '${specifier}'`) as NodeJS.ErrnoException;
  err.code = "MODULE_NOT_FOUND";
  return err;
}

describe("getTracer", () => {
  beforeEach(() => {
    vi.resetModules();
    requirePeerMock.mockReset();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns null without requiring dd-trace when DD_TRACE_ENABLED is unset", async () => {
    delete process.env.DD_TRACE_ENABLED;

    const { getTracer } = await import("@/lib/datadog.js");

    expect(getTracer()).toBeNull();
    expect(requirePeerMock).not.toHaveBeenCalled();
  });

  it("returns null without requiring dd-trace when DD_TRACE_ENABLED is false", async () => {
    process.env.DD_TRACE_ENABLED = "false";

    const { getTracer } = await import("@/lib/datadog.js");

    expect(getTracer()).toBeNull();
    expect(requirePeerMock).not.toHaveBeenCalled();
  });

  it("initializes and returns the tracer with expected config when enabled and dd-trace loads", async () => {
    process.env.DD_TRACE_ENABLED = "true";
    process.env.DD_SERVICE = "my-service";
    process.env.DD_ENV = "staging";
    process.env.DD_VERSION = "2.0.0";
    process.env.DD_AGENT_HOST = "agent.internal";
    process.env.DD_DOGSTATSD_PORT = "9999";
    process.env.NODE_ENV = "production";

    const tracer = { init: vi.fn(), scope: vi.fn() };
    requirePeerMock.mockReturnValue(tracer);

    const { getTracer } = await import("@/lib/datadog.js");
    const result = getTracer();

    expect(requirePeerMock).toHaveBeenCalledWith("dd-trace");
    expect(tracer.init).toHaveBeenCalledWith({
      service: "my-service",
      env: "staging",
      version: "2.0.0",
      hostname: "agent.internal",
      port: 9999,
      logInjection: true,
      runtimeMetrics: true,
    });
    expect(result).toBe(tracer);
  });

  it("emits a warning and returns null when dd-trace cannot be resolved", async () => {
    process.env.DD_TRACE_ENABLED = "true";
    requirePeerMock.mockImplementation(() => {
      throw moduleNotFoundError("dd-trace");
    });
    const emitWarningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    const { getTracer } = await import("@/lib/datadog.js");
    const result = getTracer();

    expect(result).toBeNull();
    expect(emitWarningSpy).toHaveBeenCalledWith(
      expect.stringContaining("dd-trace is not installed")
    );

    emitWarningSpy.mockRestore();
  });

  it("emits a generic warning and returns null when dd-trace fails to load for another reason", async () => {
    process.env.DD_TRACE_ENABLED = "true";
    requirePeerMock.mockImplementation(() => {
      throw new Error("native binding failed");
    });
    const emitWarningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    const { getTracer } = await import("@/lib/datadog.js");
    const result = getTracer();

    expect(result).toBeNull();
    expect(emitWarningSpy).toHaveBeenCalledWith(expect.stringContaining("native binding failed"));

    emitWarningSpy.mockRestore();
  });

  it("memoizes the tracer across calls without requiring dd-trace more than once", async () => {
    process.env.DD_TRACE_ENABLED = "true";
    const tracer = { init: vi.fn(), scope: vi.fn() };
    requirePeerMock.mockReturnValue(tracer);

    const { getTracer } = await import("@/lib/datadog.js");
    const first = getTracer();
    const second = getTracer();

    expect(first).toBe(second);
    expect(requirePeerMock).toHaveBeenCalledTimes(1);
  });
});
