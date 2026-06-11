"use strict";
/**
 * Shared types and utilities for the recon pipeline scripts.
 * Extracted so recon-summarize.ts and recon-generate.ts stay consistent
 * without duplicating the core data model or header-tally logic.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STEP_FAILURES_DIR = exports.AUX_DIR = exports.REPLAYS_DIR = exports.CAPTURES_DIR = void 0;
exports.readJsonDir = readJsonDir;
exports.tallyResponseHeaders = tallyResponseHeaders;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
exports.CAPTURES_DIR = "/tmp/recon/graphql";
exports.REPLAYS_DIR = "/tmp/recon/replays";
exports.AUX_DIR = "/tmp/recon/aux";
exports.STEP_FAILURES_DIR = "/tmp/recon/step-failures";
function readJsonDir(dir, exclude = []) {
    try {
        return (0, node_fs_1.readdirSync)(dir)
            .filter((f) => f.endsWith(".json") && !f.endsWith(".decoded.json") && !exclude.includes(f))
            .sort()
            .map((f) => JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(dir, f), "utf8")));
    }
    catch {
        return [];
    }
}
/**
 * Counts how often each response header appears across successful replays.
 * Infrastructure headers that are never load-bearing on the request side are
 * excluded so the caller sees only candidates worth committing as BASE_HEADERS.
 */
function tallyResponseHeaders(replays) {
    const IGNORE = new Set([
        "date",
        "content-length",
        "transfer-encoding",
        "connection",
        "vary",
        "server",
        "x-request-id",
        "x-correlation-id",
        "cf-ray",
        "cf-cache-status",
        "age",
        "via",
        "etag",
        "last-modified",
        "expires",
        "pragma",
        "strict-transport-security",
        "x-content-type-options",
        "x-frame-options",
        "x-xss-protection",
    ]);
    const counts = new Map();
    const successfulReplays = replays.filter((r) => r.success && r.replayHeaders);
    for (const replay of successfulReplays) {
        for (const header of Object.keys(replay.replayHeaders)) {
            const lower = header.toLowerCase();
            if (IGNORE.has(lower))
                continue;
            counts.set(lower, (counts.get(lower) ?? 0) + 1);
        }
    }
    return counts;
}
//# sourceMappingURL=recon-shared.js.map