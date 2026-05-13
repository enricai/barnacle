/**
 * Prisma v7 configuration — consumed by `prisma` CLI commands.
 * See: https://www.prisma.io/docs/orm/reference/prisma-config-reference
 *
 * We used to `import "dotenv/config"` at the top of this file, but
 * dotenv was dropped from our direct deps (landed transitively via
 * Prisma's c12). Operators should load env with their orchestrator
 * of choice (direnv, tsx's --env-file, ops tooling); the Prisma CLI
 * then reads `process.env` here directly via `env(...)`.
 */
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "./schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
