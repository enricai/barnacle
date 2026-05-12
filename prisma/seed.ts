import { PrismaClient } from "@/generated/prisma";

import { getLogger } from "@/lib/logging";

const prisma = new PrismaClient();
const logger = getLogger({ name: "prisma/seed" });

/**
 * Seeds the database with initial data.
 * Run with: pnpm run db:seed
 *
 * Add your seed logic below as your schema grows.
 *
 * @returns Promise that resolves when seeding is complete
 */
async function main(): Promise<void> {
  logger.info("starting database seed");

  // Add your seed logic here
  // Example:
  // const user = await prisma.user.upsert({
  //   where: { email: "test@example.com" },
  //   update: {},
  //   create: {
  //     email: "test@example.com",
  //     name: "Test User",
  //   },
  // });
  // logger.info(`seeded user: ${user.email}`);

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
