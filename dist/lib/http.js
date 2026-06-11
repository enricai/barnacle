"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configureHttpDispatcher = configureHttpDispatcher;
const undici_1 = require("undici");
const config_1 = require("../config");
/**
 * Raises undici's TCP connect timeout from its 10 s hardcoded default.
 * Must be called once at process startup in every entry point that makes
 * outbound fetch calls (server.ts, scripts, etc.).
 */
function configureHttpDispatcher() {
    (0, undici_1.setGlobalDispatcher)(new undici_1.Agent({ connect: { timeout: config_1.config.scraper.connectTimeoutMs } }));
}
//# sourceMappingURL=http.js.map