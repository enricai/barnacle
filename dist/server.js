"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildServer = buildServer;
const node_crypto_1 = require("node:crypto");
const compress_1 = __importDefault(require("@fastify/compress"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const swagger_1 = __importDefault(require("@fastify/swagger"));
const swagger_ui_1 = __importDefault(require("@fastify/swagger-ui"));
const fastify_1 = __importDefault(require("fastify"));
const fastify_type_provider_zod_1 = require("fastify-type-provider-zod");
const auth_1 = __importDefault(require("./api/plugins/auth"));
const error_handler_1 = __importDefault(require("./api/plugins/error-handler"));
const request_context_1 = __importDefault(require("./api/plugins/request-context"));
const health_1 = require("./api/routes/health");
const config_1 = require("./config");
const client_1 = require("./lib/db/client");
const errors_1 = require("./lib/errors");
const http_1 = require("./lib/http");
const logging_1 = require("./lib/logging");
const loader_1 = require("./plugins/loader");
const pool_1 = require("./scraper/pool");
const logger = (0, logging_1.getLogger)({ name: "server" });
(0, http_1.configureHttpDispatcher)();
/**
 * Builds a configured (but not-yet-listening) Fastify instance. Split out
 * from `main()` so tests can call `buildServer()` and use `inject()`
 * instead of binding to a port.
 */
async function buildServer() {
    // Load a fresh config per build so tests can toggle env vars between
    // buildServer() invocations. The exported `defaultConfig` is still
    // used for module-level pieces (logger) that are process-wide.
    const cfg = (0, config_1.loadConfig)();
    const app = (0, fastify_1.default)({
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
    app.setValidatorCompiler(fastify_type_provider_zod_1.validatorCompiler);
    app.setSerializerCompiler(fastify_type_provider_zod_1.serializerCompiler);
    await app.register(helmet_1.default, {
        contentSecurityPolicy: false,
    });
    await app.register(compress_1.default, { encodings: ["gzip", "br"] });
    await app.register(rate_limit_1.default, {
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
                return (0, node_crypto_1.createHash)("sha256").update(auth).digest("hex");
            }
            return request.ip;
        },
        // We don't pass a custom errorResponseBuilder — fastify-rate-limit
        // throws a FastifyError with statusCode=429 which our setErrorHandler
        // catches and emits as the error envelope (code 1010). Keeping a single
        // error-rendering path avoids schema-serializer mismatches.
    });
    await app.register(request_context_1.default);
    await app.register(error_handler_1.default);
    await app.register(auth_1.default);
    if (cfg.docs.enabled) {
        await app.register(swagger_1.default, {
            openapi: {
                openapi: "3.1.0",
                info: {
                    title: "Barnacle Automation API",
                    description: "Site-agnostic browser automation engine. POST a structured payload to a typed endpoint; Barnacle drives a Steel + Stagehand session through the target site and returns a structured result via a plugin adapter.",
                    version: "0.1.0",
                },
                servers: [{ url: `http://${cfg.host}:${cfg.port}` }],
                components: {
                    securitySchemes: {
                        bearerAuth: { type: "http", scheme: "bearer" },
                    },
                },
            },
            transform: fastify_type_provider_zod_1.jsonSchemaTransform,
        });
        await app.register(swagger_ui_1.default, { routePrefix: "/docs" });
    }
    await app.register(health_1.healthRoutes);
    await (0, loader_1.registerRoutes)(app, cfg);
    // Drain in-flight scrape sessions and disconnect Prisma when the app
    // shuts down. Without this, SIGTERM leaves Steel sessions alive until
    // their own idle timeout kicks in (billable minutes wasted) and leaves
    // Prisma connections open past process exit.
    app.addHook("onClose", async () => {
        try {
            await (0, pool_1.drainPool)();
        }
        catch (err) {
            logger.warn(`drainPool failed during shutdown: ${(0, errors_1.toErrorMessage)(err).slice(0, 200)}`);
        }
        try {
            await client_1.prisma.$disconnect();
        }
        catch (err) {
            logger.warn(`prisma disconnect failed during shutdown: ${(0, errors_1.toErrorMessage)(err).slice(0, 200)}`);
        }
    });
    return app;
}
/**
 * Boots the HTTP server. Entry point for `pnpm run dev` and `pnpm start`.
 */
async function main() {
    const app = await buildServer();
    try {
        await app.listen({ host: config_1.config.host, port: config_1.config.port });
        logger.info(`server listening on http://${config_1.config.host}:${config_1.config.port}`);
    }
    catch (err) {
        logger.errorWithStack(err, "server failed to start");
        process.exit(1);
    }
    // Guard against double signals — an impatient orchestrator sending
    // SIGTERM twice while the first shutdown is mid-flight would spawn a
    // second concurrent shutdown, racing `app.close()` and `process.exit()`.
    // The flag makes subsequent signals idempotent: log-and-ignore.
    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) {
            logger.info(`received ${signal} during shutdown — ignoring`);
            return;
        }
        shuttingDown = true;
        logger.info(`received ${signal}, shutting down`);
        try {
            await app.close();
            process.exit(0);
        }
        catch (err) {
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
//# sourceMappingURL=server.js.map