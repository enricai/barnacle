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
