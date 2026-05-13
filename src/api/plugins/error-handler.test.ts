import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CaptchaEncounteredError,
  FieldViolationError,
  ScrapeFailureError,
  ThrottledRequestError,
  UnauthorizedError,
} from "@/api/errors";
import errorHandlerPlugin from "@/api/plugins/error-handler";

/**
 * Narrow tests for the error handler plugin — spin up a minimal Fastify
 * instance with just the plugin + a few routes that throw on purpose.
 * Verifies that every error category lands in the VPS envelope with the
 * right code + HTTP status, and that unhandled generic errors don't leak
 * stack traces.
 */

type TestApp = Awaited<ReturnType<typeof makeApp>>;

async function makeApp() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorHandlerPlugin);

  app.get("/throw/unauthorized", async () => {
    throw new UnauthorizedError();
  });
  app.get("/throw/field-violation", async () => {
    throw new FieldViolationError("bad field X");
  });
  app.get("/throw/scrape-failure", async () => {
    throw new ScrapeFailureError();
  });
  app.get("/throw/captcha", async () => {
    throw new CaptchaEncounteredError();
  });
  app.get("/throw/rate-limit", async () => {
    throw new ThrottledRequestError();
  });
  app.get("/throw/raw", async () => {
    throw new Error("internal detail that should not leak");
  });
  app.get("/throw/fastify-400", async (_request, reply) => {
    return reply.code(400).send(new Error("boom"));
  });
  app.post(
    "/validated",
    {
      schema: {
        body: z.object({ name: z.string().min(3) }),
      },
    },
    async () => ({ ok: true })
  );

  await app.ready();
  return app;
}

describe("error-handler plugin", () => {
  const appRef: { value: TestApp | null } = { value: null };

  function app(): TestApp {
    if (!appRef.value) throw new Error("app not initialized");
    return appRef.value;
  }

  beforeEach(async () => {
    appRef.value = await makeApp();
  });

  afterEach(async () => {
    if (appRef.value) await appRef.value.close();
  });

  it("emits 401 + code 1004 envelope for UnauthorizedError", async () => {
    const response = await app().inject({ method: "GET", url: "/throw/unauthorized" });
    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.status.httpStatus).toBe("UNAUTHORIZED");
    expect(body.status.details[0].code).toBe(1004);
    expect(body.status.details[0].codeDescription).toBe("AUTHORIZATION_ERROR");
  });

  it("emits 400 + code 1002 envelope for FieldViolationError", async () => {
    const response = await app().inject({ method: "GET", url: "/throw/field-violation" });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.status.details[0].code).toBe(1002);
    expect(body.status.details[0].message).toBe("bad field X");
  });

  it("emits 500 + code 2003 envelope for ScrapeFailureError", async () => {
    const response = await app().inject({ method: "GET", url: "/throw/scrape-failure" });
    expect(response.statusCode).toBe(500);
    expect(response.json().status.details[0].code).toBe(2003);
  });

  it("emits 500 + code 2004 envelope for CaptchaEncounteredError", async () => {
    const response = await app().inject({ method: "GET", url: "/throw/captcha" });
    expect(response.statusCode).toBe(500);
    expect(response.json().status.details[0].code).toBe(2004);
  });

  it("emits 429 + code 1010 envelope for ThrottledRequestError", async () => {
    const response = await app().inject({ method: "GET", url: "/throw/rate-limit" });
    expect(response.statusCode).toBe(429);
    expect(response.json().status.details[0].code).toBe(1010);
  });

  it("wraps unhandled errors in 500 + 1008 envelope and does NOT leak the original message", async () => {
    const response = await app().inject({ method: "GET", url: "/throw/raw" });
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.status.details[0].code).toBe(1008);
    expect(body.status.details[0].message).toBe("internal server error");
    // critical: raw internal details must NOT reach the client
    expect(JSON.stringify(body)).not.toContain("internal detail that should not leak");
  });

  it("converts Zod validation failures into 400 + 1002 FIELD_VIOLATION", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/validated",
      headers: { "content-type": "application/json" },
      payload: { name: "ab" }, // too short
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.status.details[0].code).toBe(1002);
  });

  it("404s emit a VPS envelope with code 1005 for unknown routes", async () => {
    const response = await app().inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json().status.details[0].code).toBe(1005);
  });
});
