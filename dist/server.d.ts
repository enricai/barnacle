import type { IncomingMessage, ServerResponse } from "node:http";
import { type FastifyInstance, type RawServerDefault } from "fastify";
import type { Logger } from "./types/logging";
/**
 * Builds a configured (but not-yet-listening) Fastify instance. Split out
 * from `main()` so tests can call `buildServer()` and use `inject()`
 * instead of binding to a port.
 */
export declare function buildServer(): Promise<FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>>;
