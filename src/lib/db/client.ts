import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { PrismaClient } from "@/generated/prisma/client";
import { getLogger } from "@/lib/logging";

const logger = getLogger({ name: "lib/db/client" });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);

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
 * Reuses a single Prisma client across `tsx watch` reloads in
 * development — otherwise each reload leaks a connection and the pg
 * pool starts rejecting new clients after a few saves.
 */
export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
