import { createHash } from "node:crypto";

import { compare } from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { UnauthorizedError } from "@/api/errors";
import { loadConfig } from "@/config";
import { getLogger } from "@/lib/logging";

const logger = getLogger({ name: "api/plugins/auth" });

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
 * Derives a short, stable fingerprint from a bcrypt hash. 12 hex chars
 * = 48 bits — enough to tell registered keys apart in a log stream
 * without making offline collision attacks viable.
 */
function fingerprintHash(hash: string): string {
  return createHash("sha256").update(hash).digest("hex").slice(0, 12);
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
  // Reload config at plugin-registration time so tests can toggle
  // DEV_BYPASS_AUTH and spin up a fresh server instance without the
  // frozen module-scope `config` singleton getting in the way.
  const cfg = loadConfig();

  // Loud startup warn if dev-bypass is active. NODE_ENV unset defaults
  // to "development" (see lib/env.ts), so a container that forgets to
  // set NODE_ENV while DEV_BYPASS_AUTH=true would silently accept
  // unauthenticated traffic without any runtime signal. Emitting at
  // plugin registration means every boot of every environment logs
  // the state — much harder to miss than discovering it via a breach.
  if (cfg.auth.devBypass && cfg.nodeEnv !== "production") {
    logger.warn(
      `DEV_BYPASS_AUTH is active (NODE_ENV=${cfg.nodeEnv}) — all requests will bypass authentication. DO NOT use this in production.`
    );
  } else if (cfg.auth.devBypass && cfg.nodeEnv === "production") {
    // devBypass=true + NODE_ENV=production means the env var is present
    // but the production guard disarmed it. Still loud-warn because
    // that's a misconfiguration worth catching.
    logger.warn(
      "DEV_BYPASS_AUTH=true in production — the production guard disarmed it, but the env var should be removed from the deploy."
    );
  }

  app.decorate(
    "authenticate",
    async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
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
        throw new UnauthorizedError("missing or malformed Authorization: Bearer header");
      }

      if (cfg.auth.hashedKeys.length === 0) {
        throw new UnauthorizedError("no API keys configured on server");
      }

      const match = await findMatchingHash(token, cfg.auth.hashedKeys);
      if (!match) {
        throw new UnauthorizedError("invalid API key");
      }

      request.apiKeyTier = "standard";
      const fingerprint = fingerprintHash(match);
      request.apiKeyFingerprint = fingerprint;
      // Bind the fingerprint onto the per-request pino child so every
      // subsequent log line for this request carries the identity
      // automatically — no scattered `{ apiKeyFingerprint: ... }`
      // calls in service code.
      request.log = request.log.child({ apiKeyFingerprint: fingerprint });
    }
  );
}

export default fp(authPlugin, {
  name: "auth",
});
