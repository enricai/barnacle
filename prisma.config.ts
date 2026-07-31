import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "./prisma/schema.prisma",

  ...(process.env.DIRECT_URL
    ? { datasource: { url: process.env.DIRECT_URL } }
    : {}),
});
