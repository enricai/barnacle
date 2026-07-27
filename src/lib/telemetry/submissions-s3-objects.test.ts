/**
 * Unit tests for the S3 submissions object-listing module.
 * `@aws-sdk/client-s3` is mocked so no network calls are made; `@/config` is
 * mocked per-test via `vi.doMock` + dynamic `import()` so each test can flip
 * `telemetry.s3.bucket` between a configured and inert state — the same
 * pattern established in `s3-sink.test.ts`.
 */

import { addDays, subDays } from "date-fns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const warnMock = vi.fn();
let clientConstructCount = 0;

vi.mock("@aws-sdk/client-s3", () => {
  class ListObjectsV2Command {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class S3Client {
    send = sendMock;
    constructor() {
      clientConstructCount++;
    }
  }
  return { ListObjectsV2Command, S3Client };
});

vi.mock("@/lib/logging", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: warnMock,
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
      readMaxObjects: 200,
      readConcurrency: 8,
    },
  },
  bedrock: { region: "us-east-1" },
};

type Config = {
  telemetry: {
    s3: {
      bucket: string | undefined;
      prefix: string;
      readMaxObjects: number;
      readConcurrency: number;
    };
  };
  bedrock: { region: string };
};

const NO_BUCKET_CONFIG: Config = {
  telemetry: {
    s3: {
      bucket: undefined,
      prefix: "telemetry",
      readMaxObjects: 200,
      readConcurrency: 8,
    },
  },
  bedrock: { region: "us-east-1" },
};

/** Re-imports the module fresh with the given config mocked in. */
async function loadModuleWithConfig(cfg: Config) {
  vi.doMock("@/config", () => ({ config: cfg }));
  vi.resetModules();
  return import("@/lib/telemetry/submissions-s3-objects.js");
}

function dayPrefix(date: Date, prefix = "telemetry"): string {
  return `${prefix}/submissions/${date.toISOString().slice(0, 10)}/`;
}

function extractPrefixes(): string[] {
  return sendMock.mock.calls.map((call) => (call[0] as { input: { Prefix: string } }).input.Prefix);
}

beforeEach(() => {
  vi.useFakeTimers();
  sendMock.mockReset();
  sendMock.mockResolvedValue({ Contents: [], IsTruncated: false });
  warnMock.mockReset();
  clientConstructCount = 0;
});

afterEach(() => {
  vi.doUnmock("@/config");
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("listSubmissionsS3Objects (bucket not configured)", () => {
  it("returns [] without constructing an S3Client or calling send", async () => {
    const mod = await loadModuleWithConfig(NO_BUCKET_CONFIG);

    const keys = await mod.listSubmissionsS3Objects({ from: "2026-07-14T00:00:00Z" });

    expect(keys).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
    expect(clientConstructCount).toBe(0);
  });
});

describe("listSubmissionsS3Objects (bucket configured)", () => {
  it("derives day prefixes inclusively from from/to, widened by one day on each side", async () => {
    const mod = await loadModuleWithConfig(BUCKET_CONFIG);

    await mod.listSubmissionsS3Objects({
      from: "2026-07-14T00:00:00Z",
      to: "2026-07-16T00:00:00Z",
    });

    expect(extractPrefixes()).toEqual([
      "telemetry/submissions/2026-07-13/",
      "telemetry/submissions/2026-07-14/",
      "telemetry/submissions/2026-07-15/",
      "telemetry/submissions/2026-07-16/",
      "telemetry/submissions/2026-07-17/",
    ]);
  });

  it("derives prefixes in UTC for a non-UTC-midnight offset input", async () => {
    const mod = await loadModuleWithConfig(BUCKET_CONFIG);

    await mod.listSubmissionsS3Objects({
      from: "2026-07-14T23:30:00-05:00",
      to: "2026-07-15T04:30:00Z",
    });

    expect(extractPrefixes()).toEqual([
      "telemetry/submissions/2026-07-14/",
      "telemetry/submissions/2026-07-15/",
      "telemetry/submissions/2026-07-16/",
    ]);
  });

  it("bounds the window to now when to is absent", async () => {
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const mod = await loadModuleWithConfig(BUCKET_CONFIG);

    await mod.listSubmissionsS3Objects({ from: "2026-07-19T00:00:00Z" });

    const prefixes = extractPrefixes();
    expect(prefixes[0]).toBe(dayPrefix(subDays(new Date("2026-07-19T00:00:00Z"), 1)));
    expect(prefixes[prefixes.length - 1]).toBe(
      dayPrefix(addDays(new Date("2026-07-20T00:00:00Z"), 1))
    );
  });

  it("defaults from to 30 days before to when from is absent", async () => {
    const mod = await loadModuleWithConfig(BUCKET_CONFIG);

    await mod.listSubmissionsS3Objects({ to: "2026-07-20T00:00:00Z" });

    const prefixes = extractPrefixes();
    const expectedStart = subDays(new Date("2026-07-20T00:00:00Z"), 31);
    expect(prefixes[0]).toBe(dayPrefix(expectedStart));
    expect(prefixes[prefixes.length - 1]).toBe(
      dayPrefix(addDays(new Date("2026-07-20T00:00:00Z"), 1))
    );
  });

  it("defaults to a 30-day window ending now when both from and to are absent", async () => {
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const mod = await loadModuleWithConfig(BUCKET_CONFIG);

    await mod.listSubmissionsS3Objects();

    const prefixes = extractPrefixes();
    expect(prefixes[0]).toBe(dayPrefix(subDays(new Date("2026-07-20T00:00:00Z"), 31)));
    expect(prefixes[prefixes.length - 1]).toBe(
      dayPrefix(addDays(new Date("2026-07-20T00:00:00Z"), 1))
    );
  });

  it("follows ContinuationToken pagination to exhaustion within a day prefix", async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: "telemetry/submissions/2026-07-13/a.ndjson" }],
        IsTruncated: true,
        NextContinuationToken: "token-1",
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: "telemetry/submissions/2026-07-13/b.ndjson" }],
        IsTruncated: false,
      });
    const mod = await loadModuleWithConfig(BUCKET_CONFIG);

    const keys = await mod.listSubmissionsS3Objects({
      from: "2026-07-14T00:00:00Z",
      to: "2026-07-14T00:00:00Z",
    });

    expect(sendMock).toHaveBeenCalledTimes(4);
    const secondCallInput = sendMock.mock.calls[1]?.[0] as {
      input: { ContinuationToken?: string };
    };
    expect(secondCallInput.input.ContinuationToken).toBe("token-1");
    expect(keys).toEqual([
      "telemetry/submissions/2026-07-13/a.ndjson",
      "telemetry/submissions/2026-07-13/b.ndjson",
    ]);
  });

  it("caps the returned key count at readMaxObjects and warns when truncated", async () => {
    sendMock.mockResolvedValue({
      Contents: [{ Key: "a.ndjson" }, { Key: "b.ndjson" }],
      IsTruncated: false,
    });
    const cfg: Config = {
      ...BUCKET_CONFIG,
      telemetry: { s3: { ...BUCKET_CONFIG.telemetry.s3, readMaxObjects: 2 } },
    };
    const mod = await loadModuleWithConfig(cfg);

    const keys = await mod.listSubmissionsS3Objects({
      from: "2026-07-14T00:00:00Z",
      to: "2026-07-14T00:00:00Z",
    });

    expect(keys).toHaveLength(2);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0]?.[0]).toContain("readMaxObjects=2");
  });

  it("does not warn when the result stays under readMaxObjects", async () => {
    sendMock.mockResolvedValue({ Contents: [{ Key: "a.ndjson" }], IsTruncated: false });
    const mod = await loadModuleWithConfig(BUCKET_CONFIG);

    const keys = await mod.listSubmissionsS3Objects({
      from: "2026-07-14T00:00:00Z",
      to: "2026-07-14T00:00:00Z",
    });

    expect(keys.length).toBeGreaterThan(0);
    expect(warnMock).not.toHaveBeenCalled();
  });
});
