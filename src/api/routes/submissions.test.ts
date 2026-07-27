import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import { submissionsRoutes } from "@/api/routes/submissions";
import { ERROR_CODES } from "@/api/schemas/common";

/**
 * Route tests for GET /v1/submissions. Auth is exercised via real authPlugin
 * registration (mirrors plugins-introspection.test.ts). The sink path is
 * injected through options so each test points at its own temp NDJSON file
 * instead of the real `.barnacle/submissions.ndjson`. The S3 half of the
 * durable source (`reconciliation-source.ts`) is mocked at its two
 * collaborator modules — mirrors `reconciliation-source.test.ts` — so the
 * route's merge-in-production wiring is covered without a real bucket.
 */

const listSubmissionsS3ObjectsMock = vi.fn();
vi.mock("@/lib/telemetry/submissions-s3-objects", () => ({
  listSubmissionsS3Objects: (...args: unknown[]) => listSubmissionsS3ObjectsMock(...args),
}));

const fetchSubmissionsS3RecordsMock = vi.fn();
vi.mock("@/lib/telemetry/submissions-s3-reader", () => ({
  fetchSubmissionsS3Records: (...args: unknown[]) => fetchSubmissionsS3RecordsMock(...args),
}));

const VALID_KEY = "test-key-for-submissions-route-99";

function makeSubmitLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "submit",
    siteId: "ats-a",
    requestId: "req-abc-123",
    joinKeys: { vivclid: "v-9981", jobReference: "56793094457_jid-1" },
    inboundPayload: { jobId: "56793094457" },
    status: "submitted",
    auditPayload: { verified: true },
    errorMessage: null,
    durationMs: 4321,
    ts: "2026-07-26T10:00:00.000Z",
    ...overrides,
  };
}

function makeBeaconLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "beacon",
    requestId: "req-abc-123",
    siteId: "ats-a",
    joinKeys: { vivclid: "v-9981", jobReference: "56793094457_jid-1" },
    beaconStatus: "fired",
    trackingUrl: "https://track.appcast.io/pixel?rid=req-abc-123",
    durationMs: 87,
    ts: "2026-07-26T10:00:05.000Z",
    ...overrides,
  };
}

function ndjson(...lines: unknown[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

async function buildApp(sinkPath?: string): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  await app.register(submissionsRoutes, { sinkPath });
  await app.ready();
  return app;
}

describe("routes/submissions GET /v1/submissions", () => {
  const preserved = {
    API_KEYS_HASHED: process.env.API_KEYS_HASHED,
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  let tmpDir: string;
  let sinkPath: string;

  beforeEach(async () => {
    const bcrypt = await import("bcryptjs");
    const hash = await bcrypt.hash(VALID_KEY, 4);
    process.env.API_KEYS_HASHED = hash;
    delete process.env.DEV_BYPASS_AUTH;
    process.env.NODE_ENV = "test";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "submissions-route-test-"));
    sinkPath = path.join(tmpDir, "submissions.ndjson");

    listSubmissionsS3ObjectsMock.mockReset().mockResolvedValue([]);
    fetchSubmissionsS3RecordsMock.mockReset();
  });

  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (preserved.API_KEYS_HASHED === undefined) delete process.env.API_KEYS_HASHED;
    else process.env.API_KEYS_HASHED = preserved.API_KEYS_HASHED;
    if (preserved.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preserved.DEV_BYPASS_AUTH;
    if (preserved.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preserved.NODE_ENV;
  });

  it("returns 401 (AUTHORIZATION_ERROR) without a bearer token", async () => {
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({ method: "GET", url: "/v1/submissions" });
      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.status.details[0].code).toBe(ERROR_CODES.AUTHORIZATION_ERROR);
    } finally {
      await app.close();
    }
  });

  it("returns 401 (AUTHORIZATION_ERROR) with an invalid bearer token", async () => {
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions",
        headers: { authorization: "Bearer wrong-token-abc" },
      });
      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.status.details[0].code).toBe(ERROR_CODES.AUTHORIZATION_ERROR);
    } finally {
      await app.close();
    }
  });

  it("returns 200 with the standard envelope and a submissions array for a valid token", async () => {
    fs.writeFileSync(sinkPath, ndjson(makeSubmitLine(), makeBeaconLine()), "utf8");
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toMatchObject({ httpStatus: "OK", details: [] });
      expect(typeof body.status.dateTime).toBe("string");
      expect(Array.isArray(body.submissions)).toBe(true);
      expect(body.submissions).toHaveLength(1);
      expect(body.total).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("forwards siteId verbatim to the reader/query layer", async () => {
    fs.writeFileSync(
      sinkPath,
      ndjson(
        makeSubmitLine({ requestId: "req-hca", siteId: "hca" }),
        makeSubmitLine({
          requestId: "req-ats-c",
          siteId: "ats-c",
          joinKeys: { vivclid: "v-other" },
        })
      ),
      "utf8"
    );
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions?siteId=hca",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.submissions).toHaveLength(1);
      expect(body.submissions[0]).toMatchObject({ requestId: "req-hca", siteId: "hca" });
    } finally {
      await app.close();
    }
  });

  it("filters to one run's row by requestId", async () => {
    fs.writeFileSync(
      sinkPath,
      ndjson(
        makeSubmitLine({ requestId: "req-target", joinKeys: { vivclid: "v-target" } }),
        makeSubmitLine({ requestId: "req-other", joinKeys: { vivclid: "v-other" } })
      ),
      "utf8"
    );
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions?requestId=req-target",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.submissions).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.submissions[0]).toMatchObject({
        requestId: "req-target",
        joinKeys: { vivclid: "v-target" },
      });
    } finally {
      await app.close();
    }
  });

  it("forwards the from/to date-range verbatim to the reader/query layer", async () => {
    fs.writeFileSync(
      sinkPath,
      ndjson(
        makeSubmitLine({ requestId: "req-early", ts: "2026-07-01T00:00:00.000Z" }),
        makeSubmitLine({
          requestId: "req-in-range",
          joinKeys: { vivclid: "v-in-range" },
          ts: "2026-07-15T00:00:00.000Z",
        }),
        makeSubmitLine({
          requestId: "req-late",
          joinKeys: { vivclid: "v-late" },
          ts: "2026-08-01T00:00:00.000Z",
        })
      ),
      "utf8"
    );
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions?from=2026-07-10T00:00:00Z&to=2026-07-20T00:00:00Z",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.submissions).toHaveLength(1);
      expect(body.submissions[0]).toMatchObject({ requestId: "req-in-range" });
    } finally {
      await app.close();
    }
  });

  it("includes the joinKeys bag and folded beaconStatus on a matched row", async () => {
    fs.writeFileSync(
      sinkPath,
      ndjson(
        makeSubmitLine({ requestId: "req-1", joinKeys: { vivclid: "v-1" } }),
        makeBeaconLine({
          requestId: "req-1",
          joinKeys: { vivclid: "v-1" },
          beaconStatus: "fired",
        }),
        makeSubmitLine({ requestId: "req-2", joinKeys: { vivclid: "v-2" } })
      ),
      "utf8"
    );
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions?requestId=req-1",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.submissions).toHaveLength(1);
      expect(body.submissions[0]).toMatchObject({
        requestId: "req-1",
        joinKeys: { vivclid: "v-1" },
        beaconStatus: "fired",
        trackingUrl: "https://track.appcast.io/pixel?rid=req-abc-123",
      });
    } finally {
      await app.close();
    }
  });

  it("filters to submitted-but-unfired runs by beaconStatus=not_fired", async () => {
    fs.writeFileSync(
      sinkPath,
      ndjson(
        makeSubmitLine({ requestId: "req-fired" }),
        makeBeaconLine({ requestId: "req-fired", beaconStatus: "fired" }),
        makeSubmitLine({ requestId: "req-unfired", joinKeys: { vivclid: "v-unfired" } })
      ),
      "utf8"
    );
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions?beaconStatus=not_fired",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.submissions).toHaveLength(1);
      expect(body.submissions[0]).toMatchObject({
        requestId: "req-unfired",
        beaconStatus: "not_fired",
        trackingUrl: null,
      });
    } finally {
      await app.close();
    }
  });

  it("surfaces a self-managing plugin's fired outcome over its earlier automatic skipped line", async () => {
    fs.writeFileSync(
      sinkPath,
      ndjson(
        makeSubmitLine({ requestId: "req-self-managed", joinKeys: { vivclid: "v-self-managed" } }),
        makeBeaconLine({
          requestId: "req-self-managed",
          joinKeys: null,
          beaconStatus: "skipped",
          trackingUrl: null,
        }),
        makeBeaconLine({
          requestId: "req-self-managed",
          joinKeys: { vivclid: "v-self-managed" },
          beaconStatus: "fired",
          trackingUrl: "https://track.example.com/pixel?rid=req-self-managed",
        })
      ),
      "utf8"
    );
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions?requestId=req-self-managed",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.submissions).toHaveLength(1);
      expect(body.submissions[0]).toMatchObject({
        requestId: "req-self-managed",
        beaconStatus: "fired",
        joinKeys: { vivclid: "v-self-managed" },
        trackingUrl: "https://track.example.com/pixel?rid=req-self-managed",
      });
    } finally {
      await app.close();
    }
  });

  it("filters to exactly the fired rows by beaconStatus=fired, excluding skipped/not_fired", async () => {
    fs.writeFileSync(
      sinkPath,
      ndjson(
        makeSubmitLine({ requestId: "req-fired", joinKeys: { vivclid: "v-fired" } }),
        makeBeaconLine({
          requestId: "req-fired",
          joinKeys: { vivclid: "v-fired" },
          beaconStatus: "fired",
        }),
        makeSubmitLine({ requestId: "req-skipped", joinKeys: { vivclid: "v-skipped" } }),
        makeBeaconLine({
          requestId: "req-skipped",
          joinKeys: null,
          beaconStatus: "skipped",
          trackingUrl: null,
        }),
        makeSubmitLine({ requestId: "req-unfired", joinKeys: { vivclid: "v-unfired" } })
      ),
      "utf8"
    );
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions?beaconStatus=fired",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.submissions).toHaveLength(1);
      expect(body.submissions[0]).toMatchObject({
        requestId: "req-fired",
        beaconStatus: "fired",
      });
    } finally {
      await app.close();
    }
  });

  it("forwards status verbatim to the reader/query layer", async () => {
    fs.writeFileSync(
      sinkPath,
      ndjson(
        makeSubmitLine({ requestId: "req-submitted", status: "submitted" }),
        makeSubmitLine({
          requestId: "req-error",
          joinKeys: { vivclid: "v-error" },
          status: "error",
        })
      ),
      "utf8"
    );
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions?status=error",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.submissions).toHaveLength(1);
      expect(body.submissions[0]).toMatchObject({ requestId: "req-error", status: "error" });
    } finally {
      await app.close();
    }
  });

  it("paginates via limit/offset while total reflects the full matched count", async () => {
    fs.writeFileSync(
      sinkPath,
      ndjson(
        makeSubmitLine({
          requestId: "req-1",
          joinKeys: { vivclid: "v-1" },
          ts: "2026-07-01T00:00:00.000Z",
        }),
        makeSubmitLine({
          requestId: "req-2",
          joinKeys: { vivclid: "v-2" },
          ts: "2026-07-02T00:00:00.000Z",
        }),
        makeSubmitLine({
          requestId: "req-3",
          joinKeys: { vivclid: "v-3" },
          ts: "2026-07-03T00:00:00.000Z",
        })
      ),
      "utf8"
    );
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions?limit=1&offset=1",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(3);
      expect(body.submissions).toHaveLength(1);
      expect(body.submissions[0]).toMatchObject({ requestId: "req-2" });
    } finally {
      await app.close();
    }
  });

  it("returns a 400 with an ERROR_CODES code for an invalid from", async () => {
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions?from=not-a-date",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.status.details[0].code).toBe(ERROR_CODES.FIELD_VIOLATION);
    } finally {
      await app.close();
    }
  });

  it("merges S3-mirrored rows into the response and counts them in total", async () => {
    fs.writeFileSync(
      sinkPath,
      ndjson(makeSubmitLine({ requestId: "req-local", joinKeys: { vivclid: "v-local" } })),
      "utf8"
    );
    listSubmissionsS3ObjectsMock.mockResolvedValue(["telemetry/submissions/2026-07-26/a.ndjson"]);
    fetchSubmissionsS3RecordsMock.mockResolvedValue([
      makeSubmitLine({ requestId: "req-s3-only", joinKeys: { vivclid: "v-s3-only" } }),
    ]);
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(2);
      expect(body.submissions).toHaveLength(2);
      expect(body.submissions.map((row: { requestId: string }) => row.requestId).sort()).toEqual([
        "req-local",
        "req-s3-only",
      ]);
    } finally {
      await app.close();
    }
  });

  it("returns 200 with an empty array (not 404) when a filter matches no rows", async () => {
    fs.writeFileSync(sinkPath, ndjson(makeSubmitLine({ requestId: "req-abc-123" })), "utf8");
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions?requestId=no-such-request",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.submissions).toEqual([]);
      expect(body.total).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("returns 200 with an empty array when the sink file does not exist", async () => {
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.submissions).toEqual([]);
      expect(body.total).toBe(0);
    } finally {
      await app.close();
    }
  });
});
