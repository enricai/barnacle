import type { FastifyInstance } from "fastify";
declare module "fastify" {
    interface FastifyInstance {
        authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    }
    interface FastifyRequest {
        apiKeyTier?: string;
        /**
         * Short SHA-256 fingerprint of the matching bcrypt hash, or the
         * literal `"dev-bypass"` when DEV_BYPASS_AUTH is used. Lets ops
         * trace "which client hit this route" in logs without leaking the
         * plaintext token or the full bcrypt hash.
         */
        apiKeyFingerprint?: string;
    }
}
/**
 * Fastify plugin exposing `app.authenticate`. Routes attach it via
 * `{ onRequest: [app.authenticate] }` to require a valid Bearer token.
 *
 * Dev-only escape hatch: `DEV_BYPASS_AUTH=true` allows unauthenticated
 * access in non-production environments. NEVER set this in prod.
 */
declare function authPlugin(app: FastifyInstance): Promise<void>;
declare const _default: typeof authPlugin;
export default _default;
