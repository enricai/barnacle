import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import fastifyCompress from "@fastify/compress";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance, type RawServerDefault } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import requestContextPlugin from "@/api/plugins/request-context";
import { healthRoutes } from "@/api/routes/health";
import { config as defaultConfig, loadConfig } from "@/config";
import { prisma } from "@/lib/db/client";
import { getLogger } from "@/lib/logging";
import { registerRoutes } from "@/plugins/loader";
import { drainPool } from "@/scraper/pool";
import type { Logger } from "@/types/logging";

const logger = getLogger({ name: "server" });

/**
 * Builds a configured (but not-yet-listening) Fastify instance. Split out
 * from `main()` so tests can call `buildServer()` and use `inject()`
 * instead of binding to a port.
 */
export async function buildServer(): Promise<
  FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>
> {
  // Load a fresh config per build so tests can toggle env vars between
  // buildServer() invocations. The exported `defaultConfig` is still
  // used for module-level pieces (logger) that are process-wide.
  const cfg = loadConfig();

  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
    // TRUST_PROXY=true is correct when behind a reverse proxy (ALB,
    // nginx, Cloudflare) — Fastify reads the real client IP from
    // X-Forwarded-For. Set TRUST_PROXY=false for bare-metal deployments
    // so attackers can't spoof the header to bypass IP-based rate
    // limiting on unauthenticated traffic.
    trustProxy: cfg.trustProxy,
    ajv: { customOptions: { strict: false } },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false,
  });
  await app.register(fastifyCompress, { encodings: ["gzip", "br"] });

  await app.register(fastifyRateLimit, {
    global: true,
    max: cfg.rateLimit.max,
    timeWindow: cfg.rateLimit.windowMs,
    keyGenerator: (request) => {
      // Rate-limit runs in onRequest, before auth populates the
      // fingerprint — so we key off the raw Authorization header here.
      // Hashing it first keeps plaintext tokens out of the rate-limit
      // plugin's in-memory key→count map.
      const auth = request.headers.authorization;
      if (typeof auth === "string" && auth.length > 0) {
        return createHash("sha256").update(auth).digest("hex");
      }
      return request.ip;
    },
    // We don't pass a custom errorResponseBuilder — fastify-rate-limit
    // throws a FastifyError with statusCode=429 which our setErrorHandler
    // catches and emits as the VPS envelope (code 1010). Keeping a single
    // error-rendering path avoids schema-serializer mismatches.
  });

  await app.register(requestContextPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);

  if (cfg.docs.enabled) {
    await app.register(fastifySwagger, {
      openapi: {
        openapi: "3.1.0",
        info: {
          title: "Barnacle — FEMA Disaster Assistance API",
          description:
            "Headless Node.js API that automates FEMA disaster assistance application submissions.",
          version: "0.1.0",
        },
        servers: [{ url: `http://${cfg.host}:${cfg.port}` }],
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer" },
          },
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(fastifySwaggerUi, { routePrefix: "/docs" });
  }

  await app.register(healthRoutes);
  await registerRoutes(app, cfg);

  // Drain in-flight scrape sessions and disconnect Prisma when the app
  // shuts down. Without this, SIGTERM leaves Steel sessions alive until
  // their own idle timeout kicks in (billable minutes wasted) and leaves
  // Prisma connections open past process exit.
  app.addHook("onClose", async () => {
    try {
      await drainPool();
    } catch (err) {
      logger.warn(`drainPool failed during shutdown: ${String(err).slice(0, 200)}`);
    }
    try {
      await prisma.$disconnect();
    } catch (err) {
      logger.warn(`prisma disconnect failed during shutdown: ${String(err).slice(0, 200)}`);
    }
  });

  return app;
}

/**
 * Boots the HTTP server. Entry point for `pnpm run dev` and `pnpm start`.
 */
async function main(): Promise<void> {
  const app = await buildServer();
  try {
    await app.listen({ host: defaultConfig.host, port: defaultConfig.port });
    logger.info(`server listening on http://${defaultConfig.host}:${defaultConfig.port}`);
  } catch (err) {
    logger.errorWithStack(err, "server failed to start");
    process.exit(1);
  }

  // Guard against double signals — an impatient orchestrator sending
  // SIGTERM twice while the first shutdown is mid-flight would spawn a
  // second concurrent shutdown, racing `app.close()` and `process.exit()`.
  // The flag makes subsequent signals idempotent: log-and-ignore.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.info(`received ${signal} during shutdown — ignoring`);
      return;
    }
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      logger.errorWithStack(err, "graceful shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Last-line-of-defense for errors escaping every `try` boundary.
  process.on("uncaughtException", (err) => {
    logger.errorWithStack(err, "uncaughtException — process will exit");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.errorWithStack(err, "unhandledRejection — process will exit");
    process.exit(1);
  });
}

const entry = process.argv[1];
if (entry && (entry.endsWith("server.ts") || entry.endsWith("server.js"))) {
  void main();
}
