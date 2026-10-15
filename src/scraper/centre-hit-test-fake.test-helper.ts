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

interface FirstClickable {
  first: () => { click: (...args: never[]) => Promise<unknown> };
}

/**
 * Gives a fake `locator()` the direct `click()` a real Stagehand locator has,
 * delegating to `first().click()`. The centred trusted click calls
 * `locator(selector).click()`, which fakes modelling only `.first()` lack.
 * A locator that already defines `click` keeps its own.
 */
export function withDirectClick<L extends FirstClickable>(
  locator: (selector: string) => L
): (selector: string) => L & { click: () => Promise<void> } {
  return (selector) => {
    const resolved = locator(selector);
    return {
      click: async (): Promise<void> => {
        await resolved.first().click();
      },
      ...resolved,
    };
  };
}
