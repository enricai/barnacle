import type { FastifyInstance } from "fastify";
/**
 * Fastify plugin that replaces Fastify's default error serializer with the
 * engine error envelope. Every non-2xx response — Zod validation failures,
 * thrown `ApiError` subclasses, 404s, unhandled crashes — serializes through
 * the same `{ status: { httpStatus, dateTime, details: [...] } }` shape all
 * clients expect.
 */
declare function errorHandlerPlugin(app: FastifyInstance): Promise<void>;
declare const _default: typeof errorHandlerPlugin;
export default _default;
