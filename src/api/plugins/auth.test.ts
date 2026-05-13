import bcrypt from "bcryptjs";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";

// Hoisted logger stub so the dev-bypass startup warn can be asserted.
// Same pattern used by retry.test.ts / graphql.test.ts for module-level
// getLogger calls.
const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({ getLogger: () => loggerStub }));

/**
 * The route-level integration tests already cover the "reject without
 * auth" path. These unit tests fill in the gaps: the happy path, the
 * dev-bypass escape hatch, and every branch of the Bearer-extraction
 * logic. Auth is security-critical — its branches warrant direct
 * coverage, not just the "did the 401 fire" assertions.
 *
 * A tiny protected route is stood up per test so auth runs in a real
 * Fastify lifecycle without dragging in the full server bootstrap.
 */

const VALID_KEY = "super-secret-test-key-123456";

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  app.get("/protected", { onRequest: [app.authenticate] }, async (request) => ({
    tier: request.apiKeyTier,
    fingerprint: request.apiKeyFingerprint,
  }));
  await app.ready();
  return app;
}

describe("api/plugins/auth", () => {
  const preserved = {
    API_KEYS_HASHED: process.env.API_KEYS_HASHED,
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(async () => {
    const hash = await bcrypt.hash(VALID_KEY, 4);
    process.env.API_KEYS_HASHED = hash;
    delete process.env.DEV_BYPASS_AUTH;
    process.env.NODE_ENV = "test";
    loggerStub.warn.mockClear();
    loggerStub.info.mockClear();
  });

  afterEach(() => {
    if (preserved.API_KEYS_HASHED === undefined) delete process.env.API_KEYS_HASHED;
    else process.env.API_KEYS_HASHED = preserved.API_KEYS_HASHED;
    if (preserved.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preserved.DEV_BYPASS_AUTH;
    if (preserved.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preserved.NODE_ENV;
  });

  it("accepts a valid Bearer token and tags the request with tier=standard + a fingerprint", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { tier: string; fingerprint: string };
      expect(body.tier).toBe("standard");
      // 12 hex chars derived from SHA-256 of the bcrypt hash — stable
      // per key, opaque to outsiders.
      expect(body.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      await app.close();
    }
  });

  it("rejects when the Authorization header is missing", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/protected" });
      expect(response.statusCode).toBe(401);
      const body = response.json() as {
        status: { httpStatus: string; details: Array<{ code: number }> };
      };
      expect(body.status.httpStatus).toBe("UNAUTHORIZED");
      expect(body.status.details[0]?.code).toBe(1004);
    } finally {
      await app.close();
    }
  });

  it("rejects a malformed header without the Bearer scheme", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: `Basic ${VALID_KEY}` },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("rejects a header with no token after 'Bearer'", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: "Bearer" },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("rejects a token shorter than the minimum guard (8 chars)", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: "Bearer short" },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("rejects when the server has no hashed keys configured", async () => {
    delete process.env.API_KEYS_HASHED;
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });
      expect(response.statusCode).toBe(401);
      const body = response.json() as {
        status: { httpStatus: string; details: Array<{ code: number }> };
      };
      expect(body.status.httpStatus).toBe("UNAUTHORIZED");
      expect(body.status.details[0]?.code).toBe(1004);
    } finally {
      await app.close();
    }
  });

  it("allows DEV_BYPASS_AUTH=true in non-production and tags tier=dev", async () => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "development";
    delete process.env.API_KEYS_HASHED;
    const app = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/protected" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ tier: "dev", fingerprint: "dev-bypass" });
    } finally {
      await app.close();
    }
  });

  it("refuses DEV_BYPASS_AUTH=true when NODE_ENV=production", async () => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "production";
    const app = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/protected" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("emits a loud startup WARN when DEV_BYPASS_AUTH is effective", async () => {
    // Misconfigured containers (NODE_ENV unset + DEV_BYPASS_AUTH=true)
    // would silently serve unauthenticated traffic. The boot-time warn
    // makes that visible in every deploy's startup logs.
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "development";
    const app = await buildApp();
    try {
      expect(loggerStub.warn).toHaveBeenCalled();
      const firstCall = loggerStub.warn.mock.calls[0]?.[0] as string;
      expect(firstCall).toMatch(/DEV_BYPASS_AUTH is active/);
      expect(firstCall).toMatch(/NODE_ENV=development/);
      expect(firstCall).toMatch(/DO NOT use this in production/);
    } finally {
      await app.close();
    }
  });

  it("emits a distinct WARN when DEV_BYPASS_AUTH=true is disarmed by NODE_ENV=production", async () => {
    // Harmless at runtime (auth still enforced) but an ops signal that
    // the env var snuck into the prod deployment and should be removed.
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "production";
    const app = await buildApp();
    try {
      expect(loggerStub.warn).toHaveBeenCalled();
      const firstCall = loggerStub.warn.mock.calls[0]?.[0] as string;
      expect(firstCall).toMatch(/DEV_BYPASS_AUTH=true in production/);
      expect(firstCall).toMatch(/should be removed from the deploy/);
    } finally {
      await app.close();
    }
  });

  it("stays silent on startup when DEV_BYPASS_AUTH is not set (normal deploy)", async () => {
    // The happy path: no warn, no info — a clean boot. Tests reuse the
    // beforeEach default which deletes DEV_BYPASS_AUTH and sets NODE_ENV=test.
    const app = await buildApp();
    try {
      expect(loggerStub.warn).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
