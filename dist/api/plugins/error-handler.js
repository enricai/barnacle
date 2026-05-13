"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const fastify_type_provider_zod_1 = require("fastify-type-provider-zod");
const zod_1 = require("zod");
const errors_1 = require("@/api/errors");
const common_1 = require("@/api/schemas/common");
/**
 * Fastify plugin that replaces Fastify's default error serializer with the
 * VPS envelope. Every non-2xx response — Zod validation failures, thrown
 * `VpsError` subclasses, 404s, unhandled crashes — serializes through the
 * same `{ status: { httpStatus, dateTime, details: [...] } }` shape RC
 * clients expect.
 */
async function errorHandlerPlugin(app) {
    app.setNotFoundHandler((_request, reply) => {
        const envelope = (0, errors_1.buildVpsEnvelope)(common_1.VPS_ERROR_CODES.RESOURCE_NOT_FOUND, `route ${_request.method} ${_request.url} not found`);
        void reply.status((0, errors_1.httpStatusForCode)(common_1.VPS_ERROR_CODES.RESOURCE_NOT_FOUND)).send(envelope);
    });
    app.setErrorHandler((error, request, reply) => {
        if ((0, fastify_type_provider_zod_1.hasZodFastifySchemaValidationErrors)(error)) {
            const message = error.validation
                .map((issue) => `${issue.instancePath || "body"}: ${issue.message}`)
                .join("; ");
            const envelope = (0, errors_1.buildVpsEnvelope)(common_1.VPS_ERROR_CODES.FIELD_VIOLATION, message);
            void reply.status(400).send(envelope);
            return;
        }
        if (error instanceof zod_1.ZodError) {
            const message = error.issues
                .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
                .join("; ");
            const envelope = (0, errors_1.buildVpsEnvelope)(common_1.VPS_ERROR_CODES.FIELD_VIOLATION, message);
            void reply.status(400).send(envelope);
            return;
        }
        if (error instanceof errors_1.VpsError) {
            const envelope = (0, errors_1.buildVpsEnvelope)(error.code, error.message, error.detailType);
            void reply.status((0, errors_1.httpStatusForCode)(error.code)).send(envelope);
            return;
        }
        const err = error;
        if (typeof err.statusCode === "number" && err.statusCode === 429) {
            const envelope = (0, errors_1.buildVpsEnvelope)(common_1.VPS_ERROR_CODES.THROTTLED_REQUEST, err.message || "rate limit exceeded");
            void reply.status(429).send(envelope);
            return;
        }
        if (typeof err.statusCode === "number" && err.statusCode < 500) {
            const envelope = (0, errors_1.buildVpsEnvelope)(common_1.VPS_ERROR_CODES.GENERIC_ERROR, err.message || "request failed");
            void reply.status(err.statusCode).send(envelope);
            return;
        }
        request.log.error({ err }, "unhandled error");
        const envelope = (0, errors_1.buildVpsEnvelope)(common_1.VPS_ERROR_CODES.GENERIC_ERROR, "internal server error");
        void reply.status(500).send(envelope);
    });
}
exports.default = (0, fastify_plugin_1.default)(errorHandlerPlugin, {
    name: "error-handler",
});
//# sourceMappingURL=error-handler.js.map