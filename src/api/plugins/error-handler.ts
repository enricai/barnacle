import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { ZodError } from "zod";

import { buildVpsEnvelope, httpStatusForCode, VpsError } from "@/api/errors";
import { VPS_ERROR_CODES } from "@/api/schemas/common";
import { CaptchaError, ScraperError } from "@/scraper/errors";

/**
 * Fastify plugin that replaces Fastify's default error serializer with the
 * VPS envelope. Every non-2xx response — Zod validation failures, thrown
 * `VpsError` subclasses, 404s, unhandled crashes — serializes through the
 * same `{ status: { httpStatus, dateTime, details: [...] } }` shape all
 * clients expect.
 */
async function errorHandlerPlugin(app: FastifyInstance): Promise<void> {
  app.setNotFoundHandler((_request, reply) => {
    const envelope = buildVpsEnvelope(
      VPS_ERROR_CODES.RESOURCE_NOT_FOUND,
      `route ${_request.method} ${_request.url} not found`
    );
    void reply.status(httpStatusForCode(VPS_ERROR_CODES.RESOURCE_NOT_FOUND)).send(envelope);
  });

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const message = error.validation
        .map((issue) => `${issue.instancePath || "body"}: ${issue.message}`)
        .join("; ");
      const envelope = buildVpsEnvelope(VPS_ERROR_CODES.FIELD_VIOLATION, message);
      void reply.status(httpStatusForCode(VPS_ERROR_CODES.FIELD_VIOLATION)).send(envelope);
      return;
    }

    if (error instanceof ZodError) {
      const message = error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; ");
      const envelope = buildVpsEnvelope(VPS_ERROR_CODES.FIELD_VIOLATION, message);
      void reply.status(httpStatusForCode(VPS_ERROR_CODES.FIELD_VIOLATION)).send(envelope);
      return;
    }

    if (error instanceof VpsError) {
      const envelope = buildVpsEnvelope(error.code, error.message, error.detailType);
      void reply.status(httpStatusForCode(error.code)).send(envelope);
      return;
    }

    // Scraper errors that escaped the service-layer catch (captcha hits,
    // exhausted selector retries, session timeouts) surface to clients as
    // the dedicated VPS codes 2004 / 2003 rather than a generic 1008 — the
    // whole reason those codes exist is for clients to distinguish scrape
    // failures from upstream portal failures.
    if (error instanceof ScraperError) {
      const code =
        error instanceof CaptchaError
          ? VPS_ERROR_CODES.CAPTCHA_ENCOUNTERED
          : VPS_ERROR_CODES.SCRAPE_FAILURE;
      const envelope = buildVpsEnvelope(code, error.message);
      void reply.status(httpStatusForCode(code)).send(envelope);
      return;
    }

    const err = error as { statusCode?: number; message?: string };
    if (typeof err.statusCode === "number" && err.statusCode === 429) {
      const envelope = buildVpsEnvelope(
        VPS_ERROR_CODES.THROTTLED_REQUEST,
        err.message || "rate limit exceeded"
      );
      void reply.status(httpStatusForCode(VPS_ERROR_CODES.THROTTLED_REQUEST)).send(envelope);
      return;
    }

    // Fastify's built-in 4xx errors (malformed JSON, method-not-allowed,
    // payload-too-large, etc.) arrive as plain Errors with `statusCode`.
    // Pass the original status through — these aren't domain errors,
    // so we stay faithful to what Fastify decided rather than re-mapping.
    if (typeof err.statusCode === "number" && err.statusCode < 500) {
      const envelope = buildVpsEnvelope(
        VPS_ERROR_CODES.GENERIC_ERROR,
        err.message || "request failed"
      );
      void reply.status(err.statusCode).send(envelope);
      return;
    }

    request.log.error({ err }, "unhandled error");
    const envelope = buildVpsEnvelope(VPS_ERROR_CODES.GENERIC_ERROR, "internal server error");
    void reply.status(httpStatusForCode(VPS_ERROR_CODES.GENERIC_ERROR)).send(envelope);
  });
}

export default fp(errorHandlerPlugin, {
  name: "error-handler",
});
