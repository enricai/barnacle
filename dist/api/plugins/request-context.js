"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const nanoid_1 = require("nanoid");
const REQUEST_ID_HEADER = "x-request-id";
const CORRELATION_ID_HEADER = "x-correlation-id";
/**
 * Propagates request IDs and correlation IDs so logs can be stitched across
 * services. Fastify generates a request ID natively; we just expose it on
 * the response header and capture the optional correlation ID.
 */
async function requestContextPlugin(app) {
    app.addHook("onRequest", async (request) => {
        const incomingRequestId = request.headers[REQUEST_ID_HEADER];
        if (typeof incomingRequestId === "string" && incomingRequestId.length > 0) {
            request.id = incomingRequestId;
        }
        else if (!request.id) {
            request.id = (0, nanoid_1.nanoid)();
        }
        const incomingCorrelationId = request.headers[CORRELATION_ID_HEADER];
        if (typeof incomingCorrelationId === "string" && incomingCorrelationId.length > 0) {
            request.correlationId = incomingCorrelationId;
        }
    });
    app.addHook("onSend", async (request, reply) => {
        reply.header(REQUEST_ID_HEADER, request.id);
        if (request.correlationId) {
            reply.header(CORRELATION_ID_HEADER, request.correlationId);
        }
    });
}
exports.default = (0, fastify_plugin_1.default)(requestContextPlugin, {
    name: "request-context",
});
//# sourceMappingURL=request-context.js.map