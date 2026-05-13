"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthRoutes = healthRoutes;
/**
 * Health and readiness probes. Ops-only routes — not part of the VPS parity
 * surface — so they bypass auth and return plain JSON instead of the VPS
 * envelope. `/healthz` is a liveness check (process is up). `/readyz`
 * indicates the server is ready to handle traffic.
 */
async function healthRoutes(app) {
    app.get("/healthz", async () => ({ status: "ok" }));
    app.get("/readyz", async () => ({
        status: "ready",
        // Future: verify DB reachability, scraper pool, etc.
    }));
}
//# sourceMappingURL=health.js.map