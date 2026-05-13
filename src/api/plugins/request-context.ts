import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { nanoid } from "nanoid";

const REQUEST_ID_HEADER = "x-request-id";
const CORRELATION_ID_HEADER = "x-correlation-id";

declare module "fastify" {
  interface FastifyRequest {
    correlationId?: string;
  }
}

/**
 * Propagates request IDs and correlation IDs so logs can be stitched across
 * services. Fastify generates a request ID natively; we just expose it on
 * the response header and capture the optional correlation ID.
 */
async function requestContextPlugin(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request: FastifyRequest) => {
    const incomingRequestId = request.headers[REQUEST_ID_HEADER];
    if (typeof incomingRequestId === "string" && incomingRequestId.length > 0) {
      request.id = incomingRequestId;
    } else if (!request.id) {
      request.id = nanoid();
    }
    const incomingCorrelationId = request.headers[CORRELATION_ID_HEADER];
    if (typeof incomingCorrelationId === "string" && incomingCorrelationId.length > 0) {
      request.correlationId = incomingCorrelationId;
    }
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    if (request.correlationId) {
      reply.header(CORRELATION_ID_HEADER, request.correlationId);
    }
  });
}

export default fp(requestContextPlugin, {
  name: "request-context",
});
