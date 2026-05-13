import { prisma } from "@/lib/db/client";
import { getLogger } from "@/lib/logging";

const logger = getLogger({ name: "prisma/seed" });

/**
 * Seeds the database with initial data. Run with: `pnpm run db:seed`.
 * Add seed logic below as the schema grows.
 */
async function main(): Promise<void> {
  logger.info("starting database seed");
  logger.info("database seed completed");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e: unknown) => {
    logger.errorWithStack(e, "seed failed");
    await prisma.$disconnect();
    process.exit(1);
  });
