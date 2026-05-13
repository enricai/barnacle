import { compare } from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { UnauthorizedError } from "@/api/errors";
import { config } from "@/config";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    apiKeyTier?: string;
  }
}

/**
 * Extracts the Bearer token from the Authorization header. Returns `null`
 * if the header is missing or malformed — callers must translate that
 * into the UnauthorizedError for VPS parity.
 */
function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  if (parts[0]?.toLowerCase() !== "bearer") return null;
  const token = parts[1];
  if (!token || token.length < 8) return null;
  return token;
}

/**
 * Compares the plaintext token against every registered bcrypt hash. We
 * walk the array linearly — bcrypt.compare is constant-time for a given
 * input + hash, and the hash count is small (tens).
 */
async function findMatchingHash(token: string, hashes: readonly string[]): Promise<string | null> {
  for (const hash of hashes) {
    if (await compare(token, hash)) return hash;
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
async function authPlugin(app: FastifyInstance): Promise<void> {
  app.decorate(
    "authenticate",
    async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      if (config.auth.devBypass && config.nodeEnv !== "production") {
        request.apiKeyTier = "dev";
        return;
      }

      const token = extractBearer(request.headers.authorization);
      if (!token) {
        throw new UnauthorizedError("missing or malformed Authorization: Bearer header");
      }

      if (config.auth.hashedKeys.length === 0) {
        throw new UnauthorizedError("no API keys configured on server");
      }

      const match = await findMatchingHash(token, config.auth.hashedKeys);
      if (!match) {
        throw new UnauthorizedError("invalid API key");
      }

      request.apiKeyTier = "standard";
    }
  );
}

export default fp(authPlugin, {
  name: "auth",
});
