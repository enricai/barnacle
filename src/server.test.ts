import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db/client";
import { buildServer } from "@/server";

vi.mock("@/lib/db/client", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("server bootstrap", () => {
  const appRef: { value: Awaited<ReturnType<typeof buildServer>> | null } = { value: null };

  beforeEach(async () => {
    appRef.value = await buildServer();
    await appRef.value.ready();
  });

  afterEach(async () => {
    if (appRef.value) await appRef.value.close();
  });

  it("serves /healthz with a 200 and plain JSON", async () => {
    const app = appRef.value;
    if (!app) throw new Error("app not initialized");
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("serves /readyz with a status report (200 or 503 depending on ambient env)", async () => {
    const app = appRef.value;
    if (!app) throw new Error("app not initialized");
    const response = await app.inject({ method: "GET", url: "/readyz" });
    // /readyz status depends on ambient env (DATABASE_URL, STEEL_API_KEY,
    // ANTHROPIC_API_KEY, live queue depth). Server-bootstrap tests assert
    // the contract — a valid readiness envelope with per-check detail —
    // not the specific pass/fail outcome, which health.test.ts exercises
    // with injected state. 200 in CI, 503 on a bare shell is both fine.
    expect([200, 503]).toContain(response.statusCode);
    const body = response.json() as {
      status: "ready" | "degraded";
      checks: {
        database: { ok: boolean };
        scraperCredentials: { ok: boolean };
        scraperPool: { ok: boolean };
      };
    };
    expect(["ready", "degraded"]).toContain(body.status);
    expect(typeof body.checks.database.ok).toBe("boolean");
    expect(typeof body.checks.scraperCredentials.ok).toBe("boolean");
    expect(typeof body.checks.scraperPool.ok).toBe("boolean");
  });

  it("returns a VPS envelope for unknown routes", async () => {
    const app = appRef.value;
    if (!app) throw new Error("app not initialized");
    const response = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(response.statusCode).toBe(404);
    const body = response.json() as {
      status: { httpStatus: string; details: Array<{ code: number }> };
    };
    expect(body.status.httpStatus).toBe("NOT_FOUND");
    expect(body.status.details[0]?.code).toBe(1005);
  });

  it("echoes back a provided x-request-id", async () => {
    const app = appRef.value;
    if (!app) throw new Error("app not initialized");
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "req-12345" },
    });
    expect(response.headers["x-request-id"]).toBe("req-12345");
  });

  it("disconnects Prisma on app.close() so SIGTERM doesn't leak connections", async () => {
    const app = appRef.value;
    if (!app) throw new Error("app not initialized");
    vi.mocked(prisma.$disconnect).mockClear();
    await app.close();
    expect(vi.mocked(prisma.$disconnect)).toHaveBeenCalledTimes(1);
    // afterEach will call close() again on the stale ref — short-circuit
    // that by clearing the ref so we don't double-close.
    appRef.value = null;
  });
});
