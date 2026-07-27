import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import { submissionsRoutes } from "@/api/routes/submissions";
import { ERROR_CODES } from "@/api/schemas/common";

/**
 * Route tests for GET /v1/submissions. Auth is exercised via real authPlugin
 * registration (mirrors plugins-introspection.test.ts). The sink path is
 * injected through options so each test points at its own temp NDJSON file
 * instead of the real `.barnacle/submissions.ndjson`.
 */

const VALID_KEY = "test-key-for-submissions-route-99";

function makeSubmitLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "submit",
    siteId: "ats-a",
    requestId: "req-abc-123",
    vivclid: "v-9981",
    jobReference: "56793094457_jid-1",
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
    vivclid: "v-9981",
    jobReference: "56793094457_jid-1",
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
        makeSubmitLine({ requestId: "req-ats-c", siteId: "ats-c", vivclid: "v-other" })
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

  it("forwards jobReference verbatim to the reader/query layer", async () => {
    fs.writeFileSync(
      sinkPath,
      ndjson(
        makeSubmitLine({ requestId: "req-1", jobReference: "56793094457_jid-1" }),
        makeSubmitLine({
          requestId: "req-2",
          jobReference: "56793094458_jid-2",
          vivclid: "v-other",
        })
      ),
      "utf8"
    );
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions?jobReference=56793094458_jid-2",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.submissions).toHaveLength(1);
      expect(body.submissions[0]).toMatchObject({
        requestId: "req-2",
        jobReference: "56793094458_jid-2",
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
          vivclid: "v-in-range",
          ts: "2026-07-15T00:00:00.000Z",
        }),
        makeSubmitLine({
          requestId: "req-late",
          vivclid: "v-late",
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

  it("filters to one run's row by vivclid, including its folded beaconStatus", async () => {
    fs.writeFileSync(
      sinkPath,
      ndjson(
        makeSubmitLine({ requestId: "req-1", vivclid: "v-1" }),
        makeBeaconLine({ requestId: "req-1", vivclid: "v-1", beaconStatus: "fired" }),
        makeSubmitLine({ requestId: "req-2", vivclid: "v-2" })
      ),
      "utf8"
    );
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions?vivclid=v-1",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.submissions).toHaveLength(1);
      expect(body.submissions[0]).toMatchObject({
        requestId: "req-1",
        vivclid: "v-1",
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
        makeSubmitLine({ requestId: "req-unfired", vivclid: "v-unfired" })
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

  it("forwards status verbatim to the reader/query layer", async () => {
    fs.writeFileSync(
      sinkPath,
      ndjson(
        makeSubmitLine({ requestId: "req-submitted", status: "submitted" }),
        makeSubmitLine({ requestId: "req-error", vivclid: "v-error", status: "error" })
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
        makeSubmitLine({ requestId: "req-1", vivclid: "v-1", ts: "2026-07-01T00:00:00.000Z" }),
        makeSubmitLine({ requestId: "req-2", vivclid: "v-2", ts: "2026-07-02T00:00:00.000Z" }),
        makeSubmitLine({ requestId: "req-3", vivclid: "v-3", ts: "2026-07-03T00:00:00.000Z" })
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

  it("returns 200 with an empty array (not 404) when a filter matches no rows", async () => {
    fs.writeFileSync(sinkPath, ndjson(makeSubmitLine({ vivclid: "v-9981" })), "utf8");
    const app = await buildApp(sinkPath);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/submissions?vivclid=no-such-vivclid",
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
