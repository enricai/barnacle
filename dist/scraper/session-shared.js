"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTimeoutFetch = createTimeoutFetch;
exports.pickRandomViewport = pickRandomViewport;
const random_1 = require("../lib/random");
/**
 * Returns a fetch wrapper that aborts after `timeoutMs` milliseconds.
 * Handles the total request timeout for Anthropic API calls; the TCP connect
 * timeout is handled separately via setGlobalDispatcher in server.ts.
 */
function createTimeoutFetch(timeoutMs) {
    return (url, init) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        // Merge with any existing signal from the caller (e.g. AI SDK's own abort signal)
        // so both can independently cancel the request.
        const signals = [controller.signal, init?.signal].filter((s) => s instanceof AbortSignal);
        const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
        return fetch(url, { ...init, signal }).finally(() => clearTimeout(timer));
    };
}
/**
 * Common desktop viewports rotated per session to reduce bot-detection
 * fingerprinting — a fixed pixel size is an easy signal to filter on.
 */
const VIEWPORTS = [
    { width: 1280, height: 720 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
];
function pickRandomViewport() {
    return (0, random_1.pickRandom)(VIEWPORTS);
}
//# sourceMappingURL=session-shared.js.map