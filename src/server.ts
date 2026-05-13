import fastifyCompress from "@fastify/compress";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import requestContextPlugin from "@/api/plugins/request-context";
import { categoryPricingRoute } from "@/api/routes/category-pricing";
import { groupPricingRoute } from "@/api/routes/group-pricing";
import { healthRoutes } from "@/api/routes/health";
import { priceChangesCategoryRoute } from "@/api/routes/price-changes-category";
import { priceChangesSuperCategoryRoute } from "@/api/routes/price-changes-super-category";
import { promotionDetailsRoute } from "@/api/routes/promotion-details";
import { sailingPackageRoute } from "@/api/routes/sailing-package";
import { sailingPackageChangesRoute } from "@/api/routes/sailing-package-changes";
import { superCategoryPricingRoute } from "@/api/routes/super-category-pricing";
import { config as defaultConfig, loadConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { startChangesWorker } from "@/workers/changes";
import { startRefreshWorker } from "@/workers/refresh";

const logger = getLogger({ name: "server" });

/**
 * Builds a configured (but not-yet-listening) Fastify instance. Split out
 * from `main()` so tests can call `buildServer()` and use `inject()`
 * instead of binding to a port.
 */
export async function buildServer() {
  // Load a fresh config per build so tests can toggle env vars between
  // buildServer() invocations. The exported `defaultConfig` is still
  // used for module-level pieces (logger, cron scheduling) that are
  // process-wide.
  const cfg = loadConfig();

  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
    trustProxy: true,
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
      const auth = request.headers.authorization;
      if (typeof auth === "string" && auth.length > 0) return auth;
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
          title: "Barnacle — RC VPS-parity API",
          description:
            "Headless Node.js API mirroring Royal Caribbean's Vendor Pricing Services (VPS) surface.",
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
  await app.register(sailingPackageRoute);
  await app.register(sailingPackageChangesRoute);
  await app.register(superCategoryPricingRoute);
  await app.register(categoryPricingRoute);
  await app.register(groupPricingRoute);
  await app.register(priceChangesSuperCategoryRoute);
  await app.register(priceChangesCategoryRoute);
  await app.register(promotionDetailsRoute);

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

  const refreshJob = startRefreshWorker();
  const changesJob = startChangesWorker();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`received ${signal}, shutting down`);
    try {
      refreshJob?.stop();
      changesJob?.stop();
      await app.close();
      process.exit(0);
    } catch (err) {
      logger.errorWithStack(err, "graceful shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const entry = process.argv[1];
if (entry && (entry.endsWith("server.ts") || entry.endsWith("server.js"))) {
  void main();
}
