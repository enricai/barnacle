"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.successEnvelope = successEnvelope;
const date_fns_1 = require("date-fns");
/**
 * Builds the VPS success envelope — `{ status: { httpStatus: "OK", ... } }`
 * merged with the domain payload. Service methods return the complete
 * VPS-shaped object so route handlers just pass them through.
 */
function successEnvelope(payload) {
    return {
        status: {
            httpStatus: "OK",
            dateTime: (0, date_fns_1.formatISO)(new Date()),
            details: [],
        },
        ...payload,
    };
}
//# sourceMappingURL=envelope.js.map