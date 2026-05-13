/**
 * Prisma Configuration File
 *
 * Prisma v7 configuration file for the Prisma CLI.
 * See: https://www.prisma.io/docs/orm/reference/prisma-config-reference
 *
 * Note: Environment variables from .env files are
 * not automatically loaded - use dotenv/config import if needed.
 */
import "dotenv/config";

import { defineConfig, env } from "prisma/config";

export default defineConfig({
  // Path to the Prisma schema file
  schema: "./schema.prisma",

  // Migration configuration
  migrations: {
    // Directory where migration files are stored
    path: "./migrations",
    // Seed command to run after migrations
    seed: "tsx ../prisma/seed.ts",
  },

  // Database connection configuration
  datasource: {
    // Primary connection URL (uses connection pooler like PgBouncer)
    url: env("DATABASE_URL"),
  },
});
