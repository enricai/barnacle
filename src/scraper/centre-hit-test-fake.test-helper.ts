import { CENTRE_AND_HIT_TEST_FN, type CentredHitTestResult } from "@/scraper/trusted-click";

/**
 * Answers the pre-click centre + hit-test probe for fake pages. Fakes (and
 * happy-dom) have no layout, so `elementFromPoint` can never land on the
 * target; reporting a hit models an unobstructed control so the click under
 * test proceeds. Returns `null` for every other expression so the fake's own
 * handling runs.
 */
export function answerCentreHitTest(expr: unknown): CentredHitTestResult | null {
  return String(expr).includes(CENTRE_AND_HIT_TEST_FN) ? { state: "hit" } : null;
}
