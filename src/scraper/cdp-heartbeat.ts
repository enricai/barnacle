import { getLogger } from "@/lib/logging";
import type { Logger } from "@/types/logging";

/**
 * `keepAlive:true` holds a browser session's CDP WebSocket open across an
 * entire multi-step flow, but a transport that goes idle during a slow step
 * is reaped by the far side's NAT/gateway (socket-close code 1006). A
 * periodic round trip over that same connection keeps it from ever going
 * idle long enough to be reaped.
 */

/** Structural shape of the CDP connection a heartbeat can ping — matches Stagehand's `CdpConnection` without importing it. */
export interface CdpConnection {
  send<R>(method: string, params?: object): Promise<R>;
}

/** Tuning knobs for {@link startCdpTransportHeartbeat}. */
export interface CdpHeartbeatOptions {
  /** Milliseconds between round trips. */
  intervalMs?: number;
  /** CDP method to invoke as the round trip; must be cheap and side-effect-free. */
  method?: string;
  logger?: Logger;
}

/** Handle returned by {@link startCdpTransportHeartbeat}. */
export interface CdpHeartbeatHandle {
  /** Stops issuing round trips and clears the underlying interval. */
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_METHOD = "Target.getTargets";

/**
 * Periodically issues a cheap CDP round trip over `conn` so an idle
 * transport during a slow flow step isn't reaped by an intermediary NAT
 * layer. A rejected round trip is logged and otherwise ignored — the next
 * tick tries again — since a single failed ping isn't evidence the
 * connection is dead, only that this particular round trip didn't land.
 */
export function startCdpTransportHeartbeat(
  conn: CdpConnection,
  options: CdpHeartbeatOptions = {}
): CdpHeartbeatHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const method = options.method ?? DEFAULT_METHOD;
  const logger = options.logger ?? getLogger({ name: "cdp-heartbeat" });

  const timer = setInterval(() => {
    conn.send(method).catch((error: unknown) => {
      logger.warn(`cdp heartbeat round trip failed: ${String(error)}`);
    });
  }, intervalMs);
  timer.unref?.();

  return {
    stop: (): void => {
      clearInterval(timer);
    },
  };
}
