"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = require("node:crypto");
const bcryptjs_1 = require("bcryptjs");
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const errors_1 = require("../../api/errors");
const config_1 = require("../../config");
const logging_1 = require("../../lib/logging");
const logger = (0, logging_1.getLogger)({ name: "api/plugins/auth" });
/**
 * Derives a short, stable fingerprint from a bcrypt hash. 12 hex chars
 * = 48 bits — enough to tell registered keys apart in a log stream
 * without making offline collision attacks viable.
 */
function fingerprintHash(hash) {
    return (0, node_crypto_1.createHash)("sha256").update(hash).digest("hex").slice(0, 12);
}
/**
 * Extracts the Bearer token from the Authorization header. Returns `null`
 * if the header is missing or malformed — callers must translate that
 * into the UnauthorizedError.
 */
function extractBearer(authHeader) {
    if (!authHeader)
        return null;
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length !== 2)
        return null;
    if (parts[0]?.toLowerCase() !== "bearer")
        return null;
    const token = parts[1];
    if (!token || token.length < 8)
        return null;
    return token;
}
/**
 * Compares the plaintext token against every registered bcrypt hash. We
 * walk the array linearly — bcrypt.compare is constant-time for a given
 * input + hash, and the hash count is small (tens).
 */
async function findMatchingHash(token, hashes) {
    for (const hash of hashes) {
        if (await (0, bcryptjs_1.compare)(token, hash))
            return hash;
    }
    return null;
}
/**
 * Fastify plugin exposing `app.authenticate`. Routes attach it via
 * `{ onRequest: [app.authenticate] }` to require a valid Bearer token.
 *
 * Dev-only escape hatch: `DEV_BYPASS_AUTH=true` allows unauthenticated
 * access in non-production environments. NEVER set this in prod.
 */
async function authPlugin(app) {
    // Reload config at plugin-registration time so tests can toggle
    // DEV_BYPASS_AUTH and spin up a fresh server instance without the
    // frozen module-scope `config` singleton getting in the way.
    const cfg = (0, config_1.loadConfig)();
    // Loud startup warn if dev-bypass is active. NODE_ENV unset defaults
    // to "development" (see lib/env.ts), so a container that forgets to
    // set NODE_ENV while DEV_BYPASS_AUTH=true would silently accept
    // unauthenticated traffic without any runtime signal. Emitting at
    // plugin registration means every boot of every environment logs
    // the state — much harder to miss than discovering it via a breach.
    if (cfg.auth.devBypass && cfg.nodeEnv !== "production") {
        logger.warn(`DEV_BYPASS_AUTH is active (NODE_ENV=${cfg.nodeEnv}) — all requests will bypass authentication. DO NOT use this in production.`);
    }
    else if (cfg.auth.devBypass && cfg.nodeEnv === "production") {
        // devBypass=true + NODE_ENV=production means the env var is present
        // but the production guard disarmed it. Still loud-warn because
        // that's a misconfiguration worth catching.
        logger.warn("DEV_BYPASS_AUTH=true in production — the production guard disarmed it, but the env var should be removed from the deploy.");
    }
    app.decorate("authenticate", async (request, _reply) => {
        if (cfg.auth.devBypass && cfg.nodeEnv !== "production") {
            request.apiKeyTier = "dev";
            // Stamp a stable sentinel fingerprint so log-aggregator
            // filters on `apiKeyFingerprint` don't miss dev-bypass traffic.
            request.apiKeyFingerprint = "dev-bypass";
            request.log = request.log.child({ apiKeyFingerprint: "dev-bypass" });
            return;
        }
        const token = extractBearer(request.headers.authorization);
        if (!token) {
            throw new errors_1.UnauthorizedError("missing or malformed Authorization: Bearer header");
        }
        if (cfg.auth.hashedKeys.length === 0) {
            throw new errors_1.UnauthorizedError("no API keys configured on server");
        }
        const match = await findMatchingHash(token, cfg.auth.hashedKeys);
        if (!match) {
            throw new errors_1.UnauthorizedError("invalid API key");
        }
        request.apiKeyTier = "standard";
        const fingerprint = fingerprintHash(match);
        request.apiKeyFingerprint = fingerprint;
        // Bind the fingerprint onto the per-request pino child so every
        // subsequent log line for this request carries the identity
        // automatically — no scattered `{ apiKeyFingerprint: ... }`
        // calls in service code.
        request.log = request.log.child({ apiKeyFingerprint: fingerprint });
    });
}
exports.default = (0, fastify_plugin_1.default)(authPlugin, {
    name: "auth",
});
//# sourceMappingURL=auth.js.map