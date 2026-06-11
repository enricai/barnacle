"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const fastify_type_provider_zod_1 = require("fastify-type-provider-zod");
const v4_1 = require("zod/v4");
const errors_1 = require("../../api/errors");
const reply_1 = require("../../api/helpers/reply");
const common_1 = require("../../api/schemas/common");
const errors_2 = require("../../scraper/errors");
/**
 * Fastify plugin that replaces Fastify's default error serializer with the
 * engine error envelope. Every non-2xx response — Zod validation failures,
 * thrown `ApiError` subclasses, 404s, unhandled crashes — serializes through
 * the same `{ status: { httpStatus, dateTime, details: [...] } }` shape all
 * clients expect.
 */
async function errorHandlerPlugin(app) {
    app.setNotFoundHandler((_request, reply) => {
        (0, reply_1.replyWithError)(reply, common_1.ERROR_CODES.RESOURCE_NOT_FOUND, `route ${_request.method} ${_request.url} not found`);
    });
    app.setErrorHandler((error, request, reply) => {
        if ((0, fastify_type_provider_zod_1.hasZodFastifySchemaValidationErrors)(error)) {
            const message = error.validation
                .map((issue) => `${issue.instancePath || "body"}: ${issue.message}`)
                .join("; ");
            (0, reply_1.replyWithError)(reply, common_1.ERROR_CODES.FIELD_VIOLATION, message);
            return;
        }
        if (error instanceof v4_1.ZodError) {
            const message = error.issues
                .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
                .join("; ");
            (0, reply_1.replyWithError)(reply, common_1.ERROR_CODES.FIELD_VIOLATION, message);
            return;
        }
        if (error instanceof errors_1.ApiError) {
            (0, reply_1.replyWithError)(reply, error.code, error.message, error.detailType);
            return;
        }
        // Scraper errors that escaped the service-layer catch (captcha hits,
        // exhausted selector retries, session timeouts) surface to clients as
        // the dedicated codes 2004 / 2003 rather than a generic 1008 — the
        // whole reason those codes exist is for clients to distinguish scrape
        // failures from upstream target-site failures.
        if (error instanceof errors_2.ScraperError) {
            const code = error instanceof errors_2.CaptchaError
                ? common_1.ERROR_CODES.CAPTCHA_ENCOUNTERED
                : common_1.ERROR_CODES.SCRAPE_FAILURE;
            (0, reply_1.replyWithError)(reply, code, error.message);
            return;
        }
        const err = error;
        if (typeof err.statusCode === "number" && err.statusCode === 429) {
            (0, reply_1.replyWithError)(reply, common_1.ERROR_CODES.THROTTLED_REQUEST, err.message || "rate limit exceeded");
            return;
        }
        // Fastify's built-in 4xx errors (malformed JSON, method-not-allowed,
        // payload-too-large, etc.) arrive as plain Errors with `statusCode`.
        // Pass the original status through — these aren't domain errors,
        // so we stay faithful to what Fastify decided rather than re-mapping.
        if (typeof err.statusCode === "number" && err.statusCode < 500) {
            (0, reply_1.replyWithError)(reply, common_1.ERROR_CODES.GENERIC_ERROR, err.message || "request failed", undefined, err.statusCode);
            return;
        }
        request.log.error({ err }, "unhandled error");
        (0, reply_1.replyWithError)(reply, common_1.ERROR_CODES.GENERIC_ERROR, "internal server error");
    });
}
exports.default = (0, fastify_plugin_1.default)(errorHandlerPlugin, {
    name: "error-handler",
});
//# sourceMappingURL=error-handler.js.map