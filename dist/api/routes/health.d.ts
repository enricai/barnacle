import type { FastifyInstance } from "fastify";
import { type RunState } from "../../lib/telemetry/run-state";
/**
 * Narrow subset of AppConfig the readiness probe needs. Kept inline
 * rather than imported as `Pick<AppConfig,…>` to keep this module
 * decoupled — health checks shouldn't be coupled to config surface
 * churn beyond these fields.
 */
export interface HealthConfig {
    databaseUrl: string | undefined;
    scraper: {
        steelApiKey: string | undefined;
        anthropicApiKey: string | undefined;
        readinessQueueThreshold: number;
        useBedrock: boolean;
    };
    bedrock: {
        accessKeyId: string | undefined;
        secretAccessKey: string | undefined;
        region: string;
    };
}
interface HealthRoutesOptions {
    config?: HealthConfig;
    /** Override for tests — defaults to the live pool stats. */
    poolStats?: () => {
        size: number;
        pending: number;
        concurrency: number;
    };
    /** Override for tests — defaults to the live response-cache stats. */
    cacheStats?: () => {
        size: number;
        max: number;
        inFlight: number;
    };
    /** Override for tests — defaults to the live telemetry run state. */
    telemetryState?: () => RunState;
    /**
     * Override for tests — root directory scanned for heal-out/<siteId>/healing-<siteId>.md.
     * Defaults to process.cwd().
     */
    healOutRoot?: string;
}
/**
 * Health and readiness probes. Ops-only routes — bypass auth and return plain JSON instead
 * of the standard envelope. `/healthz` is a liveness check (process is up). `/readyz`
 * verifies external dependencies and downgrades to 503 when any are
 * unreachable so orchestrators stop routing traffic.
 *
 * Config is injected so tests can swap in specific states without
 * relying on frozen-at-import process.env.
 */
export declare function healthRoutes(app: FastifyInstance, options?: HealthRoutesOptions): Promise<void>;
export {};
