import type { FastifyInstance } from "fastify";

/**
 * Health and readiness probes. Ops-only routes — not part of the VPS parity
 * surface — so they bypass auth and return plain JSON instead of the VPS
 * envelope. `/healthz` is a liveness check (process is up). `/readyz`
 * indicates the server is ready to handle traffic.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async () => ({
    status: "ready",
    // Future: verify DB reachability, scraper pool, etc.
  }));
}
