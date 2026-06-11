import pino from "pino";
import type { Logger } from "../types/logging";
/**
 * Splits a message that exceeds CloudWatch's 256KB per-event cap. Prefers
 * newline / space boundaries so chunks stay readable; falls back to a
 * UTF-8-safe byte boundary so we don't slice through a multi-byte char.
 *
 * Exported for direct testing — the runtime emit path runs through a
 * silent pino in NODE_ENV=test, so chunking is otherwise unobservable.
 * Callers outside this module should use the logger methods instead.
 */
export declare function splitLargeMessage(message: string, maxSize?: number): string[];
/**
 * Wraps a pino logger with the project's extended Logger interface: CloudWatch
 * message splitting on every level method, and `errorWithStack` for one-line
 * error logs that include the stack inline. Used internally by `getLogger` and
 * exported so callers with an existing pino instance (e.g. `request.log`) can
 * promote it to the full Logger contract without creating a new logger.
 */
export declare function extendLogger(logger: pino.Logger): Logger;
/**
 * Returns a pino logger with pino-pretty transport unconditionally — for
 * one-shot CLI scripts where human-readable output is required in all
 * environments. Satisfies CLAUDE.md's "never console" rule without
 * emitting raw JSON that obscures progress output.
 */
export declare function getScriptLogger(name: string): Logger;
/**
 * Creates a named pino logger with the project's standard wiring:
 * pino-pretty transport in dev, JSON in prod, silent in test, secrets
 * redacted, and every string message auto-chunked under CloudWatch's
 * 256KB event cap. `name` appears as `{appName}://{name}` on every line.
 */
export declare function getLogger({ name, level }: {
    name: string;
    level?: string;
}): Logger;
