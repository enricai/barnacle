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
import { CaptchaError, SelectorFailureError, SessionTimeoutError } from "@/scraper/errors";

/**
 * Narrow tests for the error handler plugin — spin up a minimal Fastify
 * instance with just the plugin + a few routes that throw on purpose.
 * Verifies that every error category lands in the error envelope with the
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
  app.get("/throw/fastify-4xx", async () => {
    // Simulate a generic Fastify error with a 4xx status that isn't 429
    // and isn't an ApiError — e.g. @fastify/helmet content-security-policy
    // rejections surface this way.
    const err = new Error("unprocessable request") as Error & { statusCode: number };
    err.statusCode = 422;
    throw err;
  });
  app.get("/throw/zod-direct", async () => {
    // Direct ZodError (not via fastify's schema validator) — the
    // service layer occasionally re-parses inputs and throws.
    z.object({ must: z.string() }).parse({});
  });
  app.get("/throw/zod-root", async () => {
    // ZodError whose issue has an empty `path` — exercises the
    // "|| body" fallback in the direct-ZodError handler.
    z.string().parse(42);
  });
  app.get("/throw/fastify-429-no-message", async () => {
    // 429 path without an `err.message` — exercises the "rate limit
    // exceeded" fallback for the default ThrottledRequest wording.
    const err = new Error("") as Error & { statusCode: number };
    err.statusCode = 429;
    throw err;
  });
  app.get("/throw/fastify-4xx-no-message", async () => {
    // 4xx path without an `err.message` — exercises the
    // "request failed" fallback in the generic <500 branch.
    const err = new Error("") as Error & { statusCode: number };
    err.statusCode = 422;
    throw err;
  });
  app.get("/throw/scraper-captcha", async () => {
    // A CaptchaError raised from the scraper layer (not an ApiError) —
    // the error-handler must still route it to code 2004 rather
    // than the generic 1008 fallback.
    throw new CaptchaError("hCaptcha challenge encountered");
  });
  app.get("/throw/scraper-selector", async () => {
    // Selector failures are the most common Stagehand failure mode.
    // They must surface as SCRAPE_FAILURE (2003) so clients can
    // distinguish our scrape pain from upstream portal pain.
    throw new SelectorFailureError("could not find .price button after 3 retries");
  });
  app.get("/throw/scraper-session-timeout", async () => {
    throw new SessionTimeoutError();
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

  it("maps scraper CaptchaError (not ApiError) to code 2004 envelope", async () => {
    const response = await app().inject({ method: "GET", url: "/throw/scraper-captcha" });
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.status.details[0].code).toBe(2004);
    expect(body.status.details[0].codeDescription).toBe("CAPTCHA_ENCOUNTERED");
    expect(body.status.details[0].message).toBe("hCaptcha challenge encountered");
  });

  it("maps scraper SelectorFailureError to code 2003 envelope", async () => {
    const response = await app().inject({ method: "GET", url: "/throw/scraper-selector" });
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.status.details[0].code).toBe(2003);
    expect(body.status.details[0].codeDescription).toBe("SCRAPE_FAILURE");
    expect(body.status.details[0].message).toMatch(/could not find .price button/);
  });

  it("maps scraper SessionTimeoutError to code 2003 envelope", async () => {
    const response = await app().inject({ method: "GET", url: "/throw/scraper-session-timeout" });
    expect(response.statusCode).toBe(500);
    expect(response.json().status.details[0].code).toBe(2003);
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

  it("404s emit an error envelope with code 1005 for unknown routes", async () => {
    const response = await app().inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json().status.details[0].code).toBe(1005);
  });

  it("wraps a generic Fastify 4xx error in GENERIC_ERROR (1008) + passes through the status", async () => {
    const response = await app().inject({ method: "GET", url: "/throw/fastify-4xx" });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.status.details[0].code).toBe(1008);
    // Message must reach the client — 4xx errors are safe to surface.
    expect(body.status.details[0].message).toBe("unprocessable request");
  });

  it("converts a directly-thrown ZodError into 400 + 1002 FIELD_VIOLATION", async () => {
    const response = await app().inject({ method: "GET", url: "/throw/zod-direct" });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.status.details[0].code).toBe(1002);
    expect(body.status.details[0].message).toContain("must");
  });

  it("labels root-level ZodError issues with 'body' when path is empty", async () => {
    // Covers the `issue.path.join('.') || 'body'` fallback — when a
    // top-level primitive is parsed with the wrong schema, Zod emits
    // an issue with path=[] which would otherwise serialize as an
    // empty string prefix.
    const response = await app().inject({ method: "GET", url: "/throw/zod-root" });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.status.details[0].message).toContain("body");
  });

  it("uses the default message when a 429 Fastify error has no body", async () => {
    // Covers the `err.message || 'rate limit exceeded'` fallback. The
    // Fastify rate-limit plugin sometimes throws with a populated
    // message; other 429 sources may not — either way the envelope
    // should carry a human-readable detail.
    const response = await app().inject({ method: "GET", url: "/throw/fastify-429-no-message" });
    expect(response.statusCode).toBe(429);
    const body = response.json();
    expect(body.status.details[0].code).toBe(1010);
    expect(body.status.details[0].message).toBe("rate limit exceeded");
  });

  it("uses the default message when a generic 4xx Fastify error has no body", async () => {
    // Covers the `err.message || 'request failed'` fallback for the
    // generic-4xx branch.
    const response = await app().inject({ method: "GET", url: "/throw/fastify-4xx-no-message" });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.status.details[0].code).toBe(1008);
    expect(body.status.details[0].message).toBe("request failed");
  });
});
