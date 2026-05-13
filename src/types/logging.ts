import type pino from "pino";

/**
 * Project-wide logger type. Extends pino's Logger with `errorWithStack` so
 * callers can log an Error object and its stack trace in a single call without
 * having to serialize the stack manually. All logger instances returned by
 * `getLogger()` satisfy this interface.
 */
export interface Logger extends pino.Logger {
  errorWithStack: (error: unknown, msg?: string) => void;
}
