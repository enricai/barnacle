import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

const REAL_SITES = resolve(__dirname, "./src/sites");
const RECON_GENERATE_SITES = resolve(__dirname, "./tmp/recon-generate/src/sites");

// Plugins emitted by recon-generate tests live under RECON_GENERATE_CWD
// (src/scripts/recon-generate-cwd.test-helper.ts) but import their own files as
// `@/sites/<siteId>/...`, which the `@` alias has already pointed at the real
// src/sites by the time this runs; re-root those imports onto the scratch tree.
const reconGenerateSitesResolver: Plugin = {
  name: "recon-generate-sites",
  enforce: "pre",
  async resolveId(source, importer) {
    if (!importer?.startsWith(RECON_GENERATE_SITES) || !source.startsWith(`${REAL_SITES}/`)) {
      return null;
    }
    return this.resolve(RECON_GENERATE_SITES + source.slice(REAL_SITES.length), importer, {
      skipSelf: true,
    });
  },
};

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
        // Test-only helpers (real-DOM harnesses etc.) — excluded from the
        // build too (tsconfig.build.json), so they are not shippable code.
        "src/**/*.test-helper.ts",
        // Pure interface files — no executable code to cover.
        "src/types/**",
        // Steel SDK + Stagehand wiring — testing it means booting a
        // real Steel session.
        "src/scraper/session.ts",
        // Fastify server bootstrap — the entrypoint main() only fires
        // when the file is executed directly, not under vitest.
        "src/server.ts",
        // Manual regression probe — testing it means booting a real
        // Browserbase/Steel session against a live external URL.
        "src/scripts/probe-setinputfiles.ts",
      ],
      thresholds: {
        autoUpdate: false,
        statements: 79,
        branches: 74,
        functions: 83,
        lines: 80,
      },
    },
    testTimeout: 30000,
    pool: "forks",
    maxWorkers: "50%",
  },
  plugins: [reconGenerateSitesResolver],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@test": resolve(__dirname, "./test"),
    },
  },
});
