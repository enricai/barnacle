import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "@/lib/logging";
import { buildServer } from "@/server";

const logger = getLogger({ name: "scripts/generate-openapi" });

/**
 * Writes the auto-derived OpenAPI 3.1 spec (built from the Zod route
 * schemas by fastify-type-provider-zod + @fastify/swagger) to disk.
 * Useful for generating client SDKs, publishing to a docs portal, or
 * keeping a committed snapshot for PR review.
 *
 * Requires `ENABLE_DOCS=true` so swagger is registered.
 */
async function main(): Promise<void> {
  if (process.env.ENABLE_DOCS !== "true") {
    logger.error("ENABLE_DOCS must be true when generating openapi.json");
    process.exit(1);
  }

  const app = await buildServer();
  try {
    await app.ready();
    const spec = app.swagger();
    const outPath = join(process.cwd(), "openapi.json");
    writeFileSync(outPath, `${JSON.stringify(spec, null, 2)}\n`);
    logger.info(`openapi spec written to ${outPath}`);
  } finally {
    await app.close();
  }
}

void main();
