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
 * Inbound trace-id charset: letters, digits, and `-._:` — the intersection
 * of W3C trace-context, Fastify defaults, AWS X-Ray, and OpenTelemetry.
 * Anything outside is either a typo or a log-poisoning attempt; we'd rather
 * mint a fresh id than echo a CRLF / HTML / JSON fragment straight into
 * structured logs and downstream response headers.
 */
const TRACE_ID_ALLOWED = /^[A-Za-z0-9._:-]+$/;
const TRACE_ID_MAX_LEN = 128;
function isValidTraceId(value) {
    return (typeof value === "string" &&
        value.length > 0 &&
        value.length <= TRACE_ID_MAX_LEN &&
        TRACE_ID_ALLOWED.test(value));
}
/**
 * Propagates request IDs and correlation IDs so logs can be stitched across
 * services. We echo an inbound X-Request-ID when provided, otherwise
 * generate a nanoid (replacing Fastify's per-process `req-N` default,
 * which collides across pods), and always echo on response. Correlation
 * IDs are echo-only — we never invent one.
 */
async function requestContextPlugin(app) {
    app.addHook("onRequest", async (request) => {
        const incomingRequestId = request.headers[REQUEST_ID_HEADER];
        if (isValidTraceId(incomingRequestId)) {
            request.id = incomingRequestId;
        }
        else {
            // Fastify assigns a short local `req-N` id before this hook runs,
            // so we always replace it with a nanoid when the caller didn't
            // supply a trace id (or sent a malformed one). nanoid gives a
            // cross-process unique id so log aggregators can stitch requests
            // without collisions.
            request.id = (0, nanoid_1.nanoid)();
        }
        const incomingCorrelationId = request.headers[CORRELATION_ID_HEADER];
        if (isValidTraceId(incomingCorrelationId)) {
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