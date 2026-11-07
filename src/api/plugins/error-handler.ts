import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";
import { ZodError } from "zod/v4";

import { ApiError } from "@/api/errors";
import { replyWithError } from "@/api/helpers/reply";
import { ERROR_CODES } from "@/api/schemas/common";
import { invalidateResponse } from "@/cache/response-cache";
import { isCaptchaError, isScraperError } from "@/scraper/errors";
import type { DispatchMetrics } from "@/types/dispatch-metrics";

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
    const metrics = (error as unknown as { metrics?: DispatchMetrics }).metrics;

    // A response that fails its own 200 schema was produced successfully and
    // is already in the response cache: `getOrCreateInFlight` writes on
    // resolve, while serialization rejects afterwards. Left alone, every
    // identical request for the rest of the TTL is served the same 500 from
    // memory. Evict so the next caller at least re-fetches.
    //
    // `isResponseSerializationError` is the discriminator rather than
    // `instanceof ZodError`: a serializer failure arrives as a
    // `ResponseSerializationError` (statusCode 500) and is NOT a ZodError,
    // while a request-body violation arrives via
    // `hasZodFastifySchemaValidationErrors` (statusCode 400). Using the Zod
    // branch would both miss this case and risk evicting on client input
    // errors. Verified against fastify-type-provider-zod's real shapes.
    if (isResponseSerializationError(error) && request.responseCacheKey !== undefined) {
      invalidateResponse(request.responseCacheKey);
      request.log.warn(
        `response failed 200-schema serialization for ${request.method} ${request.url} — evicted its response-cache entry so the failure is not served from cache`
      );
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const message = error.validation
        .map((issue) => `${issue.instancePath || "body"}: ${issue.message}`)
        .join("; ");
      replyWithError(reply, ERROR_CODES.FIELD_VIOLATION, message, undefined, undefined, metrics);
      return;
    }

    if (error instanceof ZodError) {
      const message = error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; ");
      replyWithError(reply, ERROR_CODES.FIELD_VIOLATION, message, undefined, undefined, metrics);
      return;
    }

    if (error instanceof ApiError) {
      replyWithError(reply, error.code, error.message, error.detailType, undefined, metrics);
      return;
    }

    // Scraper errors that escaped the service-layer catch (captcha hits,
    // exhausted selector retries, session timeouts) surface to clients as
    // the dedicated codes 2004 / 2003 rather than a generic 1008 — the
    // whole reason those codes exist is for clients to distinguish scrape
    // failures from target-site failures.
    if (isScraperError(error)) {
      const code = isCaptchaError(error)
        ? ERROR_CODES.CAPTCHA_ENCOUNTERED
        : ERROR_CODES.SCRAPE_FAILURE;
      replyWithError(reply, code, error.message, undefined, undefined, metrics);
      return;
    }

    const err = error as { statusCode?: number; message?: string };
    if (typeof err.statusCode === "number" && err.statusCode === 429) {
      replyWithError(
        reply,
        ERROR_CODES.THROTTLED_REQUEST,
        err.message || "rate limit exceeded",
        undefined,
        undefined,
        metrics
      );
      return;
    }

    if (typeof err.statusCode === "number" && err.statusCode < 500) {
      replyWithError(
        reply,
        ERROR_CODES.GENERIC_ERROR,
        err.message || "request failed",
        undefined,
        err.statusCode,
        metrics
      );
      return;
    }

    // A caller that hung up mid-write (e.g. ERR_STREAM_PREMATURE_CLOSE from
    // the @fastify/compress pipeline) is not a server fault: the run outcome
    // is unaffected and the socket is dead, so log WARN and send nothing.
    // IncomingMessage.destroyed is true after a fully-read body, so test the
    // socket instead. Discriminate on the error code / socket state, never the message text.
    const rawReq = request.raw as { aborted?: boolean; socket?: { destroyed?: boolean } } | undefined;
    if (
      (error as { code?: string }).code === "ERR_STREAM_PREMATURE_CLOSE" ||
      rawReq?.aborted === true ||
      rawReq?.socket?.destroyed === true
    ) {
      request.log.warn(
        { code: (error as { code?: string }).code },
        "client disconnected before the response was written (run outcome unaffected)"
      );
      return;
    }

    request.log.error({ err }, "unhandled error");
    replyWithError(
      reply,
      ERROR_CODES.GENERIC_ERROR,
      "internal server error",
      undefined,
      undefined,
      metrics
    );
  });
}

export default fp(errorHandlerPlugin, {
  name: "error-handler",
});
