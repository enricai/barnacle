"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.replyWithError = replyWithError;
const errors_1 = require("../../api/errors");
/**
 * Sends a standard error envelope on the given reply.
 *
 * Exists because the Fastify error handler had eight near-identical
 * `buildErrorEnvelope(...)` + `reply.status(...).send(envelope)` pairs. Each
 * pair coupled an error-code lookup to a status-code lookup, and a copy-paste
 * mismatch between the two would have silently sent the wrong HTTP status.
 * Funneling every error response through this helper keeps the mapping in one
 * spot, so the only knob a caller has to think about is the error code.
 *
 * `statusOverride` is for the rare case (e.g. Fastify's built-in 4xx errors
 * that already carry a `statusCode`) where we want to preserve the upstream
 * status rather than re-deriving it from the error code.
 */
function replyWithError(reply, code, message, detailType, statusOverride) {
    const envelope = (0, errors_1.buildErrorEnvelope)(code, message, detailType);
    void reply.status(statusOverride ?? (0, errors_1.httpStatusForCode)(code)).send(envelope);
}
//# sourceMappingURL=reply.js.map