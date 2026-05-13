"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bcryptjs_1 = require("bcryptjs");
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const errors_1 = require("@/api/errors");
const config_1 = require("@/config");
/**
 * Extracts the Bearer token from the Authorization header. Returns `null`
 * if the header is missing or malformed — callers must translate that
 * into the UnauthorizedError for VPS parity.
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
    app.decorate("authenticate", async (request, _reply) => {
        if (config_1.config.auth.devBypass && config_1.config.nodeEnv !== "production") {
            request.apiKeyTier = "dev";
            return;
        }
        const token = extractBearer(request.headers.authorization);
        if (!token) {
            throw new errors_1.UnauthorizedError("missing or malformed Authorization: Bearer header");
        }
        if (config_1.config.auth.hashedKeys.length === 0) {
            throw new errors_1.UnauthorizedError("no API keys configured on server");
        }
        const match = await findMatchingHash(token, config_1.config.auth.hashedKeys);
        if (!match) {
            throw new errors_1.UnauthorizedError("invalid API key");
        }
        request.apiKeyTier = "standard";
    });
}
exports.default = (0, fastify_plugin_1.default)(authPlugin, {
    name: "auth",
});
//# sourceMappingURL=auth.js.map