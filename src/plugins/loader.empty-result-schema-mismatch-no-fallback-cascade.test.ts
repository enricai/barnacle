import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunTelemetry } from "@/lib/telemetry/run-telemetry";
import { dispatch } from "@/plugins/loader";
import { HttpSchemaError } from "@/scraper/errors";
import type { SitePlugin, SitePluginContext } from "@/site-plugin";

const mockCaptureSubmissionEnvelope = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGetCachedResponse = vi.hoisted(() =>
  vi.fn().mockReturnValue({ value: undefined, key: "test-key" })
);
const mockGetOrCreateInFlight = vi.hoisted(() =>
  vi.fn().mockImplementation((_key: string, producer: () => Promise<unknown>) => producer())
);
const mockRunWithSession = vi.hoisted(() =>
  vi.fn().mockImplementation((task: (s: null) => Promise<unknown>) => task(null))
);

vi.mock("@/scraper/pool", () => ({
  runWithSession: mockRunWithSession,
}));

vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: mockCaptureSubmissionEnvelope,
}));

vi.mock("@/cache/response-cache", () => ({
  getCachedResponse: mockGetCachedResponse,
  getOrCreateInFlight: mockGetOrCreateInFlight,
}));

const stubContext: SitePluginContext = {
  baseUrl: "https://example.com",
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as unknown as SitePluginContext["logger"],
  config: {} as SitePluginContext["config"],
  requestId: "req-test-empty-result",
  metricsCollector: {
    startStep: vi.fn(),
    endStep: vi.fn(),
    markRetry: vi.fn(),
    finalize: vi.fn(() => ({
      totalDurationMs: 0,
      path: "http" as const,
      steps: [],
      attemptCount: 1,
      startedAt: "",
      endedAt: "",
      recordedAt: "",
    })),
  } as unknown as SitePluginContext["metricsCollector"],
  recordBeaconOutcome: vi.fn().mockResolvedValue(undefined),
  telemetry: new RunTelemetry(),
};

/**
 * Synthetic "directory search" shape used instead of the reported site, per
 * this repo's site-agnostic rule: a listing envelope with a non-nullable
 * `query` leaf alongside `total`/`results` fields that a zero-match search
 * legitimately reports as `0`/`[]`.
 */
function buildDirectoryPlugin(
  executeHttp: SitePlugin<unknown, unknown>["executeHttp"],
  execute: SitePlugin<unknown, unknown>["execute"]
): SitePlugin<unknown, unknown> {
  return {
    meta: {
      siteId: "directory-search-test",
      displayName: "Directory Search Test",
      bodySchema: {} as never,
      responseSchema: {} as never,
    },
    execute,
    executeHttp,
  };
}

describe("dispatch — null-vs-non-null-leaf schema mismatch must not cascade to browser fallback", () => {
  beforeEach(() => {
    mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
    mockGetCachedResponse.mockReturnValue({ value: undefined, key: "test-key" });
    mockGetOrCreateInFlight.mockImplementation((_key: string, producer: () => Promise<unknown>) =>
      producer()
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the hot-path response without invoking execute() when the only mismatch is a non-nullable leaf reading null on an otherwise-structurally-valid zero-result body", async () => {
    const mockExecute = vi.fn();
    const mockHttpExecute = vi.fn().mockResolvedValue({
      data: { query: null, total: 0, results: [] },
    });
    const plugin = buildDirectoryPlugin(mockHttpExecute, mockExecute);

    const result = await dispatch(plugin, { query: "acme" }, stubContext);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockRunWithSession).not.toHaveBeenCalled();
    expect(result.data).toEqual({ query: null, total: 0, results: [] });
  });

  it("still cascades to execute() when the body is genuinely wrong-shaped (missing key or wrong primitive type), not merely null-vs-non-null", async () => {
    const mockExecute = vi.fn().mockResolvedValue({ data: { query: "acme", path: "browser" } });
    const mockHttpExecute = vi
      .fn()
      .mockRejectedValueOnce(new HttpSchemaError("missing required field: results"));
    const plugin = buildDirectoryPlugin(mockHttpExecute, mockExecute);

    const result = await dispatch(plugin, { query: "acme" }, stubContext);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ query: "acme", path: "browser" });
  });
});
