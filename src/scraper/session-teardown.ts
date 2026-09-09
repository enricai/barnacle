import { CdpTransportClosedError } from "@/scraper/errors";
import type { StagehandLogLine } from "@/scraper/session-browserbase";

/**
 * Substring Stagehand's own v3 transport logs at `level:0` (error) when it
 * initiates teardown of the CDP connection — verbatim across both log lines
 * of the pair ("initiating shutdown → ..." and "closing resources → ...").
 * A mid-flow occurrence means the connection layer itself is gone, not a
 * step-level failure a retry can act on in place.
 */
const TEARDOWN_MESSAGE_SUBSTRING = "CDP transport closed";
const TEARDOWN_ERROR_LEVEL = 0;

/**
 * Detects a Stagehand-initiated CDP transport teardown from its log stream
 * and exposes that as a promise that rejects the instant it's observed. A
 * dangling `page.url()` liveness check can lose the race against process
 * teardown once the event loop has nothing else keeping it alive; a
 * synchronous rejection inside the log-line callback schedules a microtask
 * that still runs even while the loop is draining, so callers racing this
 * signal see the death instead of a silent exit 0.
 */
export function createSessionTeardownDetector(): {
  watchLogLine: (line: StagehandLogLine) => void;
  deathSignal: Promise<never>;
} {
  let signalDeath: ((err: CdpTransportClosedError) => void) | undefined;
  const deathSignal = new Promise<never>((_resolve, reject) => {
    signalDeath = (err: CdpTransportClosedError): void => reject(err);
  });
  // deathSignal's executor runs synchronously above, so signalDeath is
  // always assigned before watchLogLine can be called.
  deathSignal.catch(() => undefined);

  let fired = false;
  const watchLogLine = (line: StagehandLogLine): void => {
    if (fired) return;
    if (line.level !== TEARDOWN_ERROR_LEVEL) return;
    if (!line.message.includes(TEARDOWN_MESSAGE_SUBSTRING)) return;
    fired = true;
    signalDeath?.(
      new CdpTransportClosedError(`stagehand-initiated teardown mid-flow: ${line.message}`)
    );
  };

  return { watchLogLine, deathSignal };
}

/**
 * Browserbase overshoots its own configured session timeout by 1-14s in
 * practice, never undershoots, so a lower-bound-only comparison against the
 * configured lifetime is the correct direction for classifying a teardown
 * as timeout-driven rather than an early crash or provider incident.
 */
const DEFAULT_TIMEOUT_TOLERANCE_SECONDS = 15;

/** Result of classifying a session teardown against its configured lifetime. */
export interface SessionTeardownClassification {
  /** True when the teardown landed within tolerance of the configured timeout. */
  isTimeoutHit: boolean;
  /** Log-ready message text — distinct wording for the timeout-hit case. */
  message: string;
}

/**
 * Classifies a session teardown as either a provider-driven timeout expiry
 * or a generic mid-flow teardown, and formats the corresponding log message.
 * Kept pure (no I/O, no clock reads) so callers can drive it with fake
 * elapsed-time and step-count inputs instead of a real Stagehand session.
 */
export function classifySessionTeardown(params: {
  configuredTimeoutSeconds: number;
  elapsedSeconds: number;
  completedStepCount: number;
  toleranceSeconds?: number;
}): SessionTeardownClassification {
  const {
    configuredTimeoutSeconds,
    elapsedSeconds,
    completedStepCount,
    toleranceSeconds = DEFAULT_TIMEOUT_TOLERANCE_SECONDS,
  } = params;
  const isTimeoutHit = elapsedSeconds >= configuredTimeoutSeconds - toleranceSeconds;
  const message = isTimeoutHit
    ? `Browserbase session hit its timeout after ${elapsedSeconds.toFixed(1)}s (configured ${configuredTimeoutSeconds}s); ${completedStepCount} step(s) completed before teardown`
    : `stagehand-initiated teardown mid-flow after ${elapsedSeconds.toFixed(1)}s; ${completedStepCount} step(s) completed before teardown`;
  return { isTimeoutHit, message };
}

/**
 * Races a step's own promise against a teardown death signal so a
 * Stagehand-initiated mid-flow teardown surfaces as `CdpTransportClosedError`
 * instead of the step promise hanging forever once the connection that
 * would have settled it is already gone.
 */
export function raceAgainstTeardown<T>(
  stepPromise: Promise<T>,
  deathSignal: Promise<never>
): Promise<T> {
  return Promise.race([stepPromise, deathSignal]);
}
