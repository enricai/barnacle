import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { ZodError } from "zod/v4";

import { ApiError } from "@/api/errors";
import { replyWithError } from "@/api/helpers/reply";
import { ERROR_CODES } from "@/api/schemas/common";
import { CaptchaError, ScraperError } from "@/scraper/errors";

/**
 * Fastify plugin that replaces Fastify's default error serializer with the
 * engine error envelope. Every non-2xx response — Zod validation failures,
 * thrown `ApiError` subclasses, 404s, unhandled crashes — serializes through
 * the same `{ status: { httpStatus, dateTime, details: [...] } }` shape all
 * clients expect.
 */
async function errorHandlerPlugin(app: FastifyInstance): Promise<void> {
  app.setNotFoundHandler((_request, reply) => {
    replyWithError(
      reply,
      ERROR_CODES.RESOURCE_NOT_FOUND,
      `route ${_request.method} ${_request.url} not found`
    );
  });

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const message = error.validation
        .map((issue) => `${issue.instancePath || "body"}: ${issue.message}`)
        .join("; ");
      replyWithError(reply, ERROR_CODES.FIELD_VIOLATION, message);
      return;
    }

    if (error instanceof ZodError) {
      const message = error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; ");
      replyWithError(reply, ERROR_CODES.FIELD_VIOLATION, message);
      return;
    }

    if (error instanceof ApiError) {
      replyWithError(reply, error.code, error.message, error.detailType);
      return;
    }

    // Scraper errors that escaped the service-layer catch (captcha hits,
    // exhausted selector retries, session timeouts) surface to clients as
    // the dedicated codes 2004 / 2003 rather than a generic 1008 — the
    // whole reason those codes exist is for clients to distinguish scrape
    // failures from upstream target-site failures.
    if (error instanceof ScraperError) {
      const code =
        error instanceof CaptchaError
          ? ERROR_CODES.CAPTCHA_ENCOUNTERED
          : ERROR_CODES.SCRAPE_FAILURE;
      replyWithError(reply, code, error.message);
      return;
    }

    const err = error as { statusCode?: number; message?: string };
    if (typeof err.statusCode === "number" && err.statusCode === 429) {
      replyWithError(reply, ERROR_CODES.THROTTLED_REQUEST, err.message || "rate limit exceeded");
      return;
    }

    // Fastify's built-in 4xx errors (malformed JSON, method-not-allowed,
    // payload-too-large, etc.) arrive as plain Errors with `statusCode`.
    // Pass the original status through — these aren't domain errors,
    // so we stay faithful to what Fastify decided rather than re-mapping.
    if (typeof err.statusCode === "number" && err.statusCode < 500) {
      replyWithError(
        reply,
        ERROR_CODES.GENERIC_ERROR,
        err.message || "request failed",
        undefined,
        err.statusCode
      );
      return;
    }

    request.log.error({ err }, "unhandled error");
    replyWithError(reply, ERROR_CODES.GENERIC_ERROR, "internal server error");
  });
}

export default fp(errorHandlerPlugin, {
  name: "error-handler",
});
