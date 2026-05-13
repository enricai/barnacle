/**
 * Prisma v7 configuration — consumed by `prisma` CLI commands.
 * See: https://www.prisma.io/docs/orm/reference/prisma-config-reference
 */
import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "./prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
