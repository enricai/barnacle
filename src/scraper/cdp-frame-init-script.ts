import type { Page } from "@browserbasehq/stagehand";

import { getLogger } from "@/lib/logging";

/**
 * Deterministic, per-CDP-target init-script installer. Playwright/Stagehand's
 * context-level `addInitScript` re-sends the script into every session it
 * already knows about, but a same-origin child iframe attaches to the SAME
 * target as its parent and a cross-origin child iframe attaches to a brand
 * new target whose own scripts can start running before that context-level
 * call's round trip lands — the install-vs-render race this module closes.
 */

const logger = getLogger({ name: "scraper/cdp-frame-init-script" });

/** `Target.attachedToTarget` event shape this module reads. */
interface TargetAttachedToTargetParams {
  sessionId: string;
}

interface CdpSessionLike {
  send<R = unknown>(method: string, params?: object): Promise<R>;
  on<P = unknown>(event: string, handler: (params: P) => void): void;
}

interface CdpFramePage {
  getSessionForFrame(frameId: string): CdpSessionLike;
  getSessionById(id: string): CdpSessionLike | undefined;
  mainFrameId(): string;
}

const install = (session: CdpSessionLike, source: string): Promise<void> =>
  session
    .send("Page.addScriptToEvaluateOnNewDocument", { source })
    .then(() => undefined)
    .catch((err: unknown) => {
      logger.warn(`cdp frame init script: script registration failed: ${String(err)}`);
    });

/**
 * Recurses because `Target.setAutoAttach` is per-session: a grandchild target
 * attached under a child session never inherits the main session's call, so
 * every newly attached session must re-arm auto-attach on itself.
 */
const arm = (session: CdpSessionLike, page: CdpFramePage, source: string): Promise<void> => {
  session.on<TargetAttachedToTargetParams>("Target.attachedToTarget", (params) => {
    const childSession = page.getSessionById(params.sessionId);
    if (!childSession) {
      logger.warn(
        `cdp frame init script: no session found for attached target ${params.sessionId}`
      );
      return;
    }
    Promise.all([install(childSession, source), arm(childSession, page, source)])
      .then(() => childSession.send("Runtime.runIfWaitingForDebugger"))
      .catch((err: unknown) => {
        logger.warn(`cdp frame init script: child target resume failed: ${String(err)}`);
      });
  });

  return session
    .send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    })
    .then(() => undefined)
    .catch((err: unknown) => {
      logger.warn(`cdp frame init script: Target.setAutoAttach failed: ${String(err)}`);
    });
};

/**
 * Installs `source` into every frame's realm before that frame's own scripts
 * execute — including a newly-attached same-origin child iframe (covered by
 * `Page.addScriptToEvaluateOnNewDocument`, a Page-domain command the CDP
 * contract applies to every frame of the target it's sent to) and a
 * newly-attached cross-origin child target (paused via `Target.setAutoAttach`
 * before any of its scripts run, installed into its own session, and only
 * then resumed via `Runtime.runIfWaitingForDebugger`).
 *
 * Must be wired as the sole per-target install path for a given script — the
 * race this closes only stays closed if nothing else independently resumes a
 * paused target before this module's install lands.
 */
export async function installInitScriptOnAllFrames(page: Page, source: string): Promise<void> {
  const framePage = page as unknown as CdpFramePage;
  const session = framePage.getSessionForFrame(framePage.mainFrameId());
  await Promise.all([install(session, source), arm(session, framePage, source)]);
}
