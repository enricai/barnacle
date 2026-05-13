"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const logging_1 = require("@/lib/logging");
const server_1 = require("@/server");
const logger = (0, logging_1.getLogger)({ name: "scripts/generate-openapi" });
/**
 * Writes the auto-derived OpenAPI 3.1 spec (built from the Zod route
 * schemas by fastify-type-provider-zod + @fastify/swagger) to disk.
 * Useful for generating client SDKs, publishing to a docs portal, or
 * keeping a committed snapshot for PR review.
 *
 * Requires `ENABLE_DOCS=true` so swagger is registered.
 */
async function main() {
    if (process.env.ENABLE_DOCS !== "true") {
        logger.error("ENABLE_DOCS must be true when generating openapi.json");
        process.exit(1);
    }
    const app = await (0, server_1.buildServer)();
    try {
        await app.ready();
        const spec = app.swagger();
        const outPath = (0, node_path_1.join)(process.cwd(), "openapi.json");
        (0, node_fs_1.writeFileSync)(outPath, `${JSON.stringify(spec, null, 2)}\n`);
        logger.info(`openapi spec written to ${outPath}`);
    }
    finally {
        await app.close();
    }
}
void main();
//# sourceMappingURL=generate-openapi.js.map