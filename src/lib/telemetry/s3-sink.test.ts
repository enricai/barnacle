/**
 * Unit tests for the buffered S3 telemetry sink. `@aws-sdk/client-s3` is
 * mocked so no network calls are made; `@/config` is mocked per-test via
 * `vi.doMock` + dynamic `import()` so each test can flip
 * `telemetry.s3.bucket` between a configured and inert state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class S3Client {
    send = sendMock;
  }
  return { PutObjectCommand, S3Client };
});

vi.mock("@/lib/logging", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  }),
}));

const BUCKET_CONFIG = {
  telemetry: {
    s3: {
      bucket: "test-bucket",
      prefix: "telemetry",
      flushIntervalMs: 60_000,
      maxBufferLines: 500,
    },
  },
  bedrock: { region: "us-east-1" },
};

const NO_BUCKET_CONFIG = {
  telemetry: {
    s3: {
      bucket: undefined,
      prefix: "telemetry",
      flushIntervalMs: 60_000,
      maxBufferLines: 500,
    },
  },
  bedrock: { region: "us-east-1" },
};

/** Re-imports the module fresh with the given config mocked in. */
async function loadSinkWithConfig(cfg: typeof BUCKET_CONFIG | typeof NO_BUCKET_CONFIG) {
  vi.doMock("@/config", () => ({ config: cfg }));
  vi.resetModules();
  return import("@/lib/telemetry/s3-sink.js");
}

beforeEach(() => {
  vi.useFakeTimers();
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
});

afterEach(() => {
  vi.doUnmock("@/config");
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("s3-sink (bucket configured)", () => {
  it("accumulates buffered lines without flushing", async () => {
    const sink = await loadSinkWithConfig(BUCKET_CONFIG);
    sink.bufferCallLine('{"a":1}\n');
    sink.bufferCallLine('{"a":2}\n');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("flushTelemetryToS3 calls PutObjectCommand with correct bucket, key, body, and content type", async () => {
    const sink = await loadSinkWithConfig(BUCKET_CONFIG);
    sink.bufferCallLine('{"a":1}\n');
    sink.bufferCallLine('{"a":2}\n');

    await sink.flushTelemetryToS3();

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(command.input.Bucket).toBe("test-bucket");
    expect(command.input.Key).toMatch(
      /^telemetry\/calls\/\d{4}-\d{2}-\d{2}\/[^/]+-\d+-[0-9a-f]{8}\.ndjson$/
    );
    expect(command.input.Body).toBe('{"a":1}\n{"a":2}\n');
    expect(command.input.ContentType).toBe("application/x-ndjson");
  });

  it("uploads calls and submissions buffers as separate objects", async () => {
    const sink = await loadSinkWithConfig(BUCKET_CONFIG);
    sink.bufferCallLine('{"a":1}\n');
    sink.bufferSubmissionLine('{"b":1}\n');

    await sink.flushTelemetryToS3();

    expect(sendMock).toHaveBeenCalledTimes(2);
    const keys = sendMock.mock.calls.map(
      (call) => (call[0] as { input: Record<string, unknown> }).input.Key as string
    );
    expect(keys.some((k) => k.startsWith("telemetry/calls/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("telemetry/submissions/"))).toBe(true);
  });

  it("empty-buffer flush is a no-op", async () => {
    const sink = await loadSinkWithConfig(BUCKET_CONFIG);
    await sink.flushTelemetryToS3();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("keeps the buffer intact for retry when upload fails", async () => {
    const sink = await loadSinkWithConfig(BUCKET_CONFIG);
    sendMock.mockRejectedValueOnce(new Error("network error"));
    sink.bufferCallLine('{"a":1}\n');

    await sink.flushTelemetryToS3();
    expect(sendMock).toHaveBeenCalledTimes(1);

    sendMock.mockResolvedValueOnce({});
    await sink.flushTelemetryToS3();

    expect(sendMock).toHaveBeenCalledTimes(2);
    const secondCommand = sendMock.mock.calls[1]?.[0] as { input: Record<string, unknown> };
    expect(secondCommand.input.Body).toBe('{"a":1}\n');
  });

  it("drops the oldest lines past the 5000-line hard cap", async () => {
    const sink = await loadSinkWithConfig({
      ...BUCKET_CONFIG,
      telemetry: { s3: { ...BUCKET_CONFIG.telemetry.s3, maxBufferLines: 100_000 } },
    });
    for (let i = 0; i < 5010; i++) {
      sink.bufferCallLine(`{"i":${i}}\n`);
    }

    await sink.flushTelemetryToS3();

    const command = sendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    const body = command.input.Body as string;
    const lines = body.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(5000);
    expect(lines[0]).toBe('{"i":10}');
    expect(lines[lines.length - 1]).toBe('{"i":5009}');
  });

  it("flushes early once a buffer crosses maxBufferLines", async () => {
    const sink = await loadSinkWithConfig({
      ...BUCKET_CONFIG,
      telemetry: { s3: { ...BUCKET_CONFIG.telemetry.s3, maxBufferLines: 3 } },
    });

    sink.bufferCallLine('{"a":1}\n');
    sink.bufferCallLine('{"a":2}\n');
    expect(sendMock).not.toHaveBeenCalled();

    sink.bufferCallLine('{"a":3}\n');
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    const command = sendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(command.input.Body).toBe('{"a":1}\n{"a":2}\n{"a":3}\n');
  });

  it("coalesces concurrent flush calls into a single upload", async () => {
    let resolveSend: ((value: unknown) => void) | undefined;
    sendMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        })
    );
    const sink = await loadSinkWithConfig(BUCKET_CONFIG);
    sink.bufferCallLine('{"a":1}\n');

    const first = sink.flushTelemetryToS3();
    const second = sink.flushTelemetryToS3();

    expect(sendMock).toHaveBeenCalledTimes(1);
    resolveSend?.({});
    await Promise.all([first, second]);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("shutdownS3Sink clears the timer and flushes remaining lines", async () => {
    const sink = await loadSinkWithConfig(BUCKET_CONFIG);
    sink.startS3SinkTimer();
    sink.bufferCallLine('{"a":1}\n');

    await sink.shutdownS3Sink();

    expect(sendMock).toHaveBeenCalledTimes(1);

    sendMock.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("s3-sink (bucket not configured)", () => {
  it("bufferCallLine and bufferSubmissionLine never construct a client or accumulate lines", async () => {
    const sink = await loadSinkWithConfig(NO_BUCKET_CONFIG);
    sink.bufferCallLine('{"a":1}\n');
    sink.bufferSubmissionLine('{"b":1}\n');

    await sink.flushTelemetryToS3();

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("startS3SinkTimer never schedules a flush", async () => {
    const sink = await loadSinkWithConfig(NO_BUCKET_CONFIG);
    sink.startS3SinkTimer();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("shutdownS3Sink is a no-op that never calls PutObjectCommand", async () => {
    const sink = await loadSinkWithConfig(NO_BUCKET_CONFIG);
    await sink.shutdownS3Sink();
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("resetS3Sink", () => {
  it("clears buffered lines so a subsequent flush is a no-op", async () => {
    const sink = await loadSinkWithConfig(BUCKET_CONFIG);
    sink.bufferCallLine('{"a":1}\n');

    sink.resetS3Sink();
    await sink.flushTelemetryToS3();

    expect(sendMock).not.toHaveBeenCalled();
  });
});
