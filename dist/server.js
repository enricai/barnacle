"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildServer = buildServer;
const compress_1 = __importDefault(require("@fastify/compress"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const swagger_1 = __importDefault(require("@fastify/swagger"));
const swagger_ui_1 = __importDefault(require("@fastify/swagger-ui"));
const fastify_1 = __importDefault(require("fastify"));
const fastify_type_provider_zod_1 = require("fastify-type-provider-zod");
const errors_1 = require("@/api/errors");
const auth_1 = __importDefault(require("@/api/plugins/auth"));
const error_handler_1 = __importDefault(require("@/api/plugins/error-handler"));
const request_context_1 = __importDefault(require("@/api/plugins/request-context"));
const category_pricing_1 = require("@/api/routes/category-pricing");
const group_pricing_1 = require("@/api/routes/group-pricing");
const health_1 = require("@/api/routes/health");
const price_changes_category_1 = require("@/api/routes/price-changes-category");
const price_changes_super_category_1 = require("@/api/routes/price-changes-super-category");
const promotion_details_1 = require("@/api/routes/promotion-details");
const sailing_package_1 = require("@/api/routes/sailing-package");
const sailing_package_changes_1 = require("@/api/routes/sailing-package-changes");
const super_category_pricing_1 = require("@/api/routes/super-category-pricing");
const common_1 = require("@/api/schemas/common");
const config_1 = require("@/config");
const logging_1 = require("@/lib/logging");
const changes_1 = require("@/workers/changes");
const refresh_1 = require("@/workers/refresh");
const logger = (0, logging_1.getLogger)({ name: "server" });
/**
 * Builds a configured (but not-yet-listening) Fastify instance. Split out
 * from `main()` so tests can call `buildServer()` and use `inject()`
 * instead of binding to a port.
 */
async function buildServer() {
    const app = (0, fastify_1.default)({
        loggerInstance: logger,
        disableRequestLogging: false,
        trustProxy: true,
        ajv: { customOptions: { strict: false } },
    });
    app.setValidatorCompiler(fastify_type_provider_zod_1.validatorCompiler);
    app.setSerializerCompiler(fastify_type_provider_zod_1.serializerCompiler);
    await app.register(helmet_1.default, {
        contentSecurityPolicy: false,
    });
    await app.register(compress_1.default, { encodings: ["gzip", "br"] });
    await app.register(rate_limit_1.default, {
        max: config_1.config.rateLimit.max,
        timeWindow: config_1.config.rateLimit.windowMs,
        keyGenerator: (request) => {
            const auth = request.headers.authorization;
            if (typeof auth === "string" && auth.length > 0)
                return auth;
            return request.ip;
        },
        errorResponseBuilder: (_request, context) => {
            const envelope = (0, errors_1.buildVpsEnvelope)(common_1.VPS_ERROR_CODES.THROTTLED_REQUEST, `rate limit exceeded; retry after ${context.after}`);
            return envelope;
        },
    });
    await app.register(request_context_1.default);
    await app.register(error_handler_1.default);
    await app.register(auth_1.default);
    if (config_1.config.docs.enabled) {
        await app.register(swagger_1.default, {
            openapi: {
                openapi: "3.1.0",
                info: {
                    title: "Barnacle — RC VPS-parity API",
                    description: "Headless Node.js API mirroring Royal Caribbean's Vendor Pricing Services (VPS) surface.",
                    version: "0.1.0",
                },
                servers: [{ url: `http://${config_1.config.host}:${config_1.config.port}` }],
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
    await app.register(sailing_package_1.sailingPackageRoute);
    await app.register(sailing_package_changes_1.sailingPackageChangesRoute);
    await app.register(super_category_pricing_1.superCategoryPricingRoute);
    await app.register(category_pricing_1.categoryPricingRoute);
    await app.register(group_pricing_1.groupPricingRoute);
    await app.register(price_changes_super_category_1.priceChangesSuperCategoryRoute);
    await app.register(price_changes_category_1.priceChangesCategoryRoute);
    await app.register(promotion_details_1.promotionDetailsRoute);
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
    const refreshJob = (0, refresh_1.startRefreshWorker)();
    const changesJob = (0, changes_1.startChangesWorker)();
    const shutdown = async (signal) => {
        logger.info(`received ${signal}, shutting down`);
        try {
            refreshJob?.stop();
            changesJob?.stop();
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
}
const entry = process.argv[1];
if (entry && (entry.endsWith("server.ts") || entry.endsWith("server.js"))) {
    void main();
}
//# sourceMappingURL=server.js.map