import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { PrismaClient } from "@/generated/prisma/client";
import { getLoggerFromFilename } from "@/lib/logging";

const logger = getLoggerFromFilename({ filename: __filename });

/**
 * PostgreSQL connection pool configuration.
 * Uses DATABASE_URL environment variable for connection string.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Prisma driver adapter using pg pool.
 * Provides better connection handling and pooling for PostgreSQL.
 */
const adapter = new PrismaPg(pool);

/**
 * Global Prisma client instance with PostgreSQL driver adapter.
 * Uses singleton pattern to prevent multiple instances in development.
 *
 * @returns Prisma client instance configured with pg adapter
 */
function createPrismaClient(): PrismaClient {
  logger.debug("creating prisma client with pg adapter");
  return new PrismaClient({
    adapter,
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Singleton Prisma client instance.
 * Reuses existing instance in development to prevent connection exhaustion.
 */
export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
