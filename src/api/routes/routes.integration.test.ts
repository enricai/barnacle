import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "@/server";

/**
 * Route-level integration tests that exercise auth enforcement and Zod
 * validation against the full Fastify instance. The scraper services are
 * NOT invoked — we only check that requests get rejected before they
 * reach a service handler when the input is malformed or unauthorized.
 */

const TEST_API_KEY = "test-key-with-enough-length";

describe("VPS route auth + validation", () => {
  const appRef: { value: Awaited<ReturnType<typeof buildServer>> | null } = { value: null };
  const preservedEnv: { API_KEYS_HASHED: string | undefined } = {
    API_KEYS_HASHED: process.env.API_KEYS_HASHED,
  };

  beforeAll(async () => {
    const hash = await bcrypt.hash(TEST_API_KEY, 4);
    process.env.API_KEYS_HASHED = hash;
    appRef.value = await buildServer();
    await appRef.value.ready();
  });

  afterAll(async () => {
    if (appRef.value) await appRef.value.close();
    process.env.API_KEYS_HASHED = preservedEnv.API_KEYS_HASHED;
  });

  it("rejects sailing-package without Bearer auth using VPS envelope", async () => {
    const app = appRef.value;
    if (!app) throw new Error("app not initialized");
    const response = await app.inject({
      method: "GET",
      url: "/v1/catalog/sailing-package?brandCode=R&fromSailDate=2025-06-01&toSailDate=2025-06-30",
    });
    expect(response.statusCode).toBe(401);
    const body = response.json() as {
      status: { httpStatus: string; details: Array<{ code: number }> };
    };
    expect(body.status.httpStatus).toBe("UNAUTHORIZED");
    expect(body.status.details[0]?.code).toBe(1004);
  });

  it("rejects super-category-pricing without Bearer auth", async () => {
    const app = appRef.value;
    if (!app) throw new Error("app not initialized");
    const response = await app.inject({
      method: "POST",
      url: "/v1/partner-pricing/super-category-pricing",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects invalid Bearer tokens", async () => {
    const app = appRef.value;
    if (!app) throw new Error("app not initialized");
    const response = await app.inject({
      method: "POST",
      url: "/v1/promotion/promotion-details",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-key-value-123",
      },
      payload: { brand: "R", client: { agencyId: "A", currencyCodes: ["USD"] } },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects POST /v1/search without Bearer auth", async () => {
    const app = appRef.value;
    if (!app) throw new Error("app not initialized");
    const response = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: { "content-type": "application/json" },
      payload: { fromSailDate: "2026-06-01", toSailDate: "2026-06-30" },
    });
    expect(response.statusCode).toBe(401);
    const body = response.json() as {
      status: { httpStatus: string; details: Array<{ code: number }> };
    };
    expect(body.status.httpStatus).toBe("UNAUTHORIZED");
    expect(body.status.details[0]?.code).toBe(1004);
  });

  it("validates POST /v1/search body and rejects malformed dates", async () => {
    const app = appRef.value;
    if (!app) throw new Error("app not initialized");
    const response = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_API_KEY}`,
      },
      payload: { fromSailDate: "not-a-date", toSailDate: "2026-06-30" },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as {
      status: { httpStatus: string; details: Array<{ code: number }> };
    };
    expect(body.status.httpStatus).toBe("BAD_REQUEST");
    expect(body.status.details[0]?.code).toBe(1002);
  });
});
