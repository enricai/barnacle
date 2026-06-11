"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
const adapter_pg_1 = require("@prisma/adapter-pg");
const pg_1 = require("pg");
const client_1 = require("../../generated/prisma/client");
const logging_1 = require("../../lib/logging");
const logger = (0, logging_1.getLogger)({ name: "lib/db/client" });
const pool = new pg_1.Pool({
    connectionString: process.env.DATABASE_URL,
});
const adapter = new adapter_pg_1.PrismaPg(pool);
function createPrismaClient() {
    logger.debug("creating prisma client with pg adapter");
    return new client_1.PrismaClient({
        adapter,
    });
}
const globalForPrisma = globalThis;
/**
 * Reuses a single Prisma client across `tsx watch` reloads in
 * development — otherwise each reload leaks a connection and the pg
 * pool starts rejecting new clients after a few saves.
 */
exports.prisma = globalForPrisma.prisma ?? createPrismaClient();
if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = exports.prisma;
}
//# sourceMappingURL=client.js.map