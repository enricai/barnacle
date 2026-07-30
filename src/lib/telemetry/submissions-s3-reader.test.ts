/**
 * Unit tests for the S3 submissions object-fetch module. `@aws-sdk/client-s3`
 * is mocked so no network calls are made; `@/config` is mocked per-test via
 * `vi.doMock` + dynamic `import()` so each test can flip
 * `telemetry.s3.bucket` between a configured and inert state — the same
 * pattern established in `s3-sink.test.ts` and `submissions-s3-objects.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const warnMock = vi.fn();
let clientConstructCount = 0;

vi.mock("@aws-sdk/client-s3", () => {
  class GetObjectCommand {
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
  return { GetObjectCommand, S3Client };
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

type Config = {
  telemetry: {
    s3: {
      bucket: string | undefined;
      readConcurrency: number;
    };
  };
  bedrock: { region: string };
};

const BUCKET_CONFIG: Config = {
  telemetry: { s3: { bucket: "test-bucket", readConcurrency: 8 } },
  bedrock: { region: "us-east-1" },
};

const NO_BUCKET_CONFIG: Config = {
  telemetry: { s3: { bucket: undefined, readConcurrency: 8 } },
  bedrock: { region: "us-east-1" },
};

/** Re-imports the module fresh with the given config mocked in. */
async function loadModuleWithConfig(cfg: Config) {
  vi.doMock("@/config", () => ({ config: cfg }));
  vi.resetModules();
  return import("@/lib/telemetry/submissions-s3-reader.js");
}

/** Builds a GetObjectCommand response with a `Body.transformToString()` matching the SDK v3 shape. */
function objectResponse(body: string): { Body: { transformToString: () => Promise<string> } } {
  return { Body: { transformToString: () => Promise.resolve(body) } };
}

function submitLine(requestId: string): string {
  return JSON.stringify({
    kind: "submit",
    siteId: "acme",
    requestId,
    joinKeys: null,
    session: null,
    inboundPayload: {},
    status: "submitted",
    auditPayload: {},
    errorMessage: null,
    durationMs: 120,
    ts: "2026-07-14T00:00:00.000Z",
  });
}

const beaconLine = JSON.stringify({
  kind: "beacon",
  requestId: "r1",
  siteId: "acme",
  joinKeys: { clickId: "v1", refId: "e1_j1" },
  beaconStatus: "fired",
  trackingUrl: "https://example.com/t",
  durationMs: 10,
  ts: "2026-07-14T00:00:01.000Z",
  sessionIp: null,
});

beforeEach(() => {
  sendMock.mockReset();
  warnMock.mockReset();
  clientConstructCount = 0;
});

afterEach(() => {
  vi.doUnmock("@/config");
  vi.clearAllMocks();
});

describe("fetchSubmissionsS3Records (bucket not configured)", () => {
  it("returns [] without constructing an S3Client", async () => {
    const mod = await loadModuleWithConfig(NO_BUCKET_CONFIG);

    const records = await mod.fetchSubmissionsS3Records([
      "telemetry/submissions/2026-07-14/a.ndjson",
    ]);

    expect(records).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
    expect(clientConstructCount).toBe(0);
  });
});

describe("fetchSubmissionsS3Records (bucket configured)", () => {
  it("parses object bodies into ReconciliationRecord[], including submit lines and beacon lines", async () => {
    sendMock.mockResolvedValue(objectResponse(`${submitLine("r1")}\n${beaconLine}\n`));
    const mod = await loadModuleWithConfig(BUCKET_CONFIG);

    const records = await mod.fetchSubmissionsS3Records([
      "telemetry/submissions/2026-07-14/a.ndjson",
    ]);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ kind: "submit", requestId: "r1", siteId: "acme" });
    expect(records[1]).toMatchObject({ kind: "beacon", requestId: "r1", beaconStatus: "fired" });
  });

  it("logs and skips an object whose GetObject rejects, still returning the remaining objects' records", async () => {
    sendMock
      .mockResolvedValueOnce(objectResponse(`${submitLine("r1")}\n`))
      .mockRejectedValueOnce(new Error("access denied"))
      .mockResolvedValueOnce(objectResponse(`${submitLine("r2")}\n`));
    const mod = await loadModuleWithConfig(BUCKET_CONFIG);

    const records = await mod.fetchSubmissionsS3Records(["a.ndjson", "b.ndjson", "c.ndjson"]);

    expect(records.map((r) => r.requestId).sort()).toEqual(["r1", "r2"]);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0]?.[0]).toContain("b.ndjson");
  });

  it("fetches objects through a p-queue bounded by config.telemetry.s3.readConcurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const resolvers: Array<() => void> = [];
    sendMock.mockImplementation(() => {
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        resolvers.push(() => {
          active--;
          resolve(objectResponse(`${submitLine("r")}\n`));
        });
      });
    });
    const cfg: Config = {
      ...BUCKET_CONFIG,
      telemetry: { s3: { ...BUCKET_CONFIG.telemetry.s3, readConcurrency: 2 } },
    };
    const mod = await loadModuleWithConfig(cfg);

    const promise = mod.fetchSubmissionsS3Records(["a", "b", "c", "d"]);

    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
    expect(maxActive).toBe(2);

    let resolvedCount = 0;
    while (resolvedCount < 4) {
      await vi.waitFor(() => expect(resolvers.length).toBeGreaterThan(0));
      resolvers.shift()?.();
      resolvedCount++;
    }

    const records = await promise;
    expect(sendMock).toHaveBeenCalledTimes(4);
    expect(records).toHaveLength(4);
    expect(maxActive).toBe(2);
  });
});
