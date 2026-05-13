"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
const adapter_pg_1 = require("@prisma/adapter-pg");
const pg_1 = require("pg");
const client_1 = require("@/generated/prisma/client");
const logging_1 = require("@/lib/logging");
const logger = (0, logging_1.getLoggerFromFilename)({ filename: __filename });
/**
 * PostgreSQL connection pool configuration.
 * Uses DATABASE_URL environment variable for connection string.
 */
const pool = new pg_1.Pool({
    connectionString: process.env.DATABASE_URL,
});
/**
 * Prisma driver adapter using pg pool.
 * Provides better connection handling and pooling for PostgreSQL.
 */
const adapter = new adapter_pg_1.PrismaPg(pool);
/**
 * Global Prisma client instance with PostgreSQL driver adapter.
 * Uses singleton pattern to prevent multiple instances in development.
 *
 * @returns Prisma client instance configured with pg adapter
 */
function createPrismaClient() {
    logger.debug("creating prisma client with pg adapter");
    return new client_1.PrismaClient({
        adapter,
    });
}
const globalForPrisma = globalThis;
/**
 * Singleton Prisma client instance.
 * Reuses existing instance in development to prevent connection exhaustion.
 */
exports.prisma = globalForPrisma.prisma ?? createPrismaClient();
if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = exports.prisma;
}
exports.default = exports.prisma;
//# sourceMappingURL=client.js.map