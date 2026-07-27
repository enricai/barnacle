/**
 * Plugin-facing entry point for recording a beacon outcome the plugin
 * navigated to itself. A plugin that declares `extractJoinKeys` on its
 * `SitePlugin` asserts it manages its own post-submit beacon navigation,
 * which locks its `dispatch()`-recorded outcome to `beaconStatus:"skipped"`
 * (see `src/plugins/loader.ts`) — this module lets such a plugin report the
 * real `fired`/`failed` outcome for the same `requestId` afterwards, without
 * the engine ever reading, validating, or interpreting its `joinKeys`.
 */

import { toErrorMessage } from "@/lib/errors";
import { getLogger } from "@/lib/logging";
import {
  captureBeaconEvent,
  type CaptureBeaconEventOptions,
} from "@/lib/telemetry/beacon-capture";

const logger = getLogger({ name: "telemetry/beacon-outcome" });

/**
 * Input a plugin supplies to report a beacon outcome for a run it navigated
 * itself. `beaconStatus` is narrowed to `"fired" | "failed"` — `"skipped"`
 * stays engine-owned (`dispatch()` writes it), so a plugin cannot muddy that
 * outcome's fold precedence. `joinKeys` is forwarded verbatim, matching the
 * opaque, plugin-owned shape precedent of `SitePluginResult.auditPayload`
 * and `extractJoinKeys` (`src/site-plugin.ts`).
 */
export interface PluginBeaconOutcomeInput {
  requestId: string;
  siteId: string;
  beaconStatus: "fired" | "failed";
  joinKeys: Record<string, unknown> | null;
  trackingUrl?: string | null;
  durationMs?: number;
}

/**
 * Records a plugin-reported beacon outcome. Never throws — a misbehaving
 * sink, or a synchronous throw/rejection from `captureBeaconEvent` itself,
 * must never break the plugin's apply flow, matching the same defense
 * `emitBeaconSafely` (`src/plugins/loader.ts`) and
 * `captureBeaconOutcomeSafely` (`src/lib/tracking-click.ts`) apply around
 * the same call.
 */
export async function recordBeaconOutcome(
  input: PluginBeaconOutcomeInput,
  opts: CaptureBeaconEventOptions = {}
): Promise<void> {
  try {
    await captureBeaconEvent(
      {
        requestId: input.requestId,
        siteId: input.siteId,
        beaconStatus: input.beaconStatus,
        joinKeys: input.joinKeys,
        trackingUrl: input.trackingUrl ?? null,
        durationMs: input.durationMs ?? 0,
      },
      opts
    );
  } catch (err) {
    logger.warn(`plugin beacon outcome recording failed: ${toErrorMessage(err)}`);
  }
}
