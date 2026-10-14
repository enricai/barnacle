import { sleep } from "@/scraper/frame-target";

export interface FollowablePage {
  waitForLoadState?(state: "domcontentloaded", timeoutMs?: number): Promise<void>;
  url?(): string;
  close?(): Promise<void>;
}

export interface FollowableContext<P extends FollowablePage> {
  pages(): P[];
  setActivePage?(page: P): void;
}

const LOAD_WAIT_MS = 10000;
const DISCOVER_POLL_MS = 100;
const DISCOVER_WAIT_MS = 1500;
const BLANK_URL_WAIT_MS = 5000;

const isBlankUrl = (page: FollowablePage): boolean => {
  try {
    const url = page.url?.() ?? "";
    return url === "" || url === "about:blank";
  } catch {
    return false;
  }
};

/**
 * Single source of truth for which page the run drives after a click: when the
 * click opened a new browsing context (non-self anchor target or window.open),
 * adopts the newest page, waits boundedly for it to load, closes the stale
 * tab so the context keeps a single driven tab, and returns the adopted page.
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
  // A new tab starts at about:blank before its navigation commits; adopting it
  // then would verify and capture an empty document.
  for (
    let waited = 0;
    isBlankUrl(opened) && waited < BLANK_URL_WAIT_MS;
    waited += DISCOVER_POLL_MS
  ) {
    await sleep(DISCOVER_POLL_MS);
  }
  // Closing first lets the context re-pick its active page before we pin ours.
  await current.close?.().catch(() => undefined);
  context.setActivePage?.(opened);
  return opened;
}
