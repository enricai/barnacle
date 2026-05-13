import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { ZodError } from "zod";

import { buildVpsEnvelope, httpStatusForCode, VpsError } from "@/api/errors";
import { VPS_ERROR_CODES } from "@/api/schemas/common";

/**
 * Fastify plugin that replaces Fastify's default error serializer with the
 * VPS envelope. Every non-2xx response — Zod validation failures, thrown
 * `VpsError` subclasses, 404s, unhandled crashes — serializes through the
 * same `{ status: { httpStatus, dateTime, details: [...] } }` shape RC
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
      void reply.status(400).send(envelope);
      return;
    }

    if (error instanceof ZodError) {
      const message = error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; ");
      const envelope = buildVpsEnvelope(VPS_ERROR_CODES.FIELD_VIOLATION, message);
      void reply.status(400).send(envelope);
      return;
    }

    if (error instanceof VpsError) {
      const envelope = buildVpsEnvelope(error.code, error.message, error.detailType);
      void reply.status(httpStatusForCode(error.code)).send(envelope);
      return;
    }

    const err = error as { statusCode?: number; message?: string };
    if (typeof err.statusCode === "number" && err.statusCode === 429) {
      const envelope = buildVpsEnvelope(
        VPS_ERROR_CODES.THROTTLED_REQUEST,
        err.message || "rate limit exceeded"
      );
      void reply.status(429).send(envelope);
      return;
    }

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
    void reply.status(500).send(envelope);
  });
}

export default fp(errorHandlerPlugin, {
  name: "error-handler",
});
