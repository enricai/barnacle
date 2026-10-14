import { sleep } from "@/scraper/frame-target";

export interface FollowablePage {
  waitForLoadState?(state: "domcontentloaded", timeoutMs?: number): Promise<void>;
}

export interface FollowableContext<P extends FollowablePage> {
  pages(): P[];
  setActivePage(page: P): void;
}

const LOAD_WAIT_MS = 10000;
const DISCOVER_POLL_MS = 100;
const DISCOVER_WAIT_MS = 1500;

/**
 * Single source of truth for which page the run drives after a click: when the
 * click opened a new browsing context (non-self anchor target or window.open),
 * adopts the newest page, waits boundedly for it to load, and returns it.
 * Returns `current` unchanged when no page appeared, so repeat calls are idempotent.
 */
export async function followNewPage<P extends FollowablePage>(
  context: FollowableContext<P>,
  current: P,
  pagesBefore: readonly P[],
  discoverWaitMs: number = DISCOVER_WAIT_MS
): Promise<P> {
  const known = new Set<P>(pagesBefore);
  const findNew = (): P | undefined =>
    context
      .pages()
      .filter((p) => !known.has(p))
      .at(-1);
  const polls = Math.max(0, Math.ceil(discoverWaitMs / DISCOVER_POLL_MS));
  let opened = findNew();
  for (let i = 0; !opened && i < polls; i++) {
    await sleep(DISCOVER_POLL_MS);
    opened = findNew();
  }
  if (!opened || opened === current) return current;
  await Promise.race([
    opened.waitForLoadState?.("domcontentloaded", LOAD_WAIT_MS).catch(() => undefined),
    sleep(LOAD_WAIT_MS),
  ]);
  context.setActivePage(opened);
  return opened;
}
