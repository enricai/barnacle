import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.ts",
        // Pure interface files — no executable code to cover.
        "src/types/**",
        // Steel SDK + Stagehand wiring — testing it means booting a
        // real Steel session.
        "src/scraper/session.ts",
        // Fastify server bootstrap — the entrypoint main() only fires
        // when the file is executed directly, not under vitest.
        "src/server.ts",
      ],
    },
    testTimeout: 30000,
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: "50%",
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@test": resolve(__dirname, "./test"),
    },
  },
});
