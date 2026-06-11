import type { FastifyInstance } from "fastify";
declare module "fastify" {
    interface FastifyRequest {
        correlationId?: string;
    }
}
/**
 * Propagates request IDs and correlation IDs so logs can be stitched across
 * services. We echo an inbound X-Request-ID when provided, otherwise
 * generate a nanoid (replacing Fastify's per-process `req-N` default,
 * which collides across pods), and always echo on response. Correlation
 * IDs are echo-only — we never invent one.
 */
declare function requestContextPlugin(app: FastifyInstance): Promise<void>;
declare const _default: typeof requestContextPlugin;
export default _default;
