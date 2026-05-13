import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "@/server";

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

  it("serves /readyz with a 200", async () => {
    const app = appRef.value;
    if (!app) throw new Error("app not initialized");
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string };
    expect(body.status).toBe("ready");
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
});
