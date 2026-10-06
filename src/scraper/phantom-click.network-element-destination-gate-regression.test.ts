import { describe, expect, it } from "vitest";

import type { PhantomClickAttempt } from "@/scraper/phantom-click";
import { classifyPhantomClick, TRIVIAL_DOM_DELTA_BYTES } from "@/scraper/phantom-click";

const URL = "https://example.com/account";

function makeAttempt(overrides: Partial<PhantomClickAttempt>): PhantomClickAttempt {
  return {
    actResultSuccess: true,
    pre: { networkCount: 0, url: URL, bodyHtmlLength: 1000 },
    post: { networkCount: 0, url: URL, bodyHtmlLength: 1000 },
    destinationPlausible: true,
    ...overrides,
  };
}

describe("scraper/phantom-click classifyPhantomClick — every effect signal requires destinationPlausible", () => {
  const signals: [string, Partial<PhantomClickAttempt>][] = [
    ["network delta", { post: { networkCount: 3, url: URL, bodyHtmlLength: 1000 } }],
    ["element state flip", { elementStateChanged: true }],
    [
      "byte growth",
      { post: { networkCount: 0, url: URL, bodyHtmlLength: 1000 + TRIVIAL_DOM_DELTA_BYTES } },
    ],
    [
      "url change",
      { post: { networkCount: 0, url: "https://example.com/login", bodyHtmlLength: 1000 } },
    ],
  ];

  it.each(signals)("%s is phantom when the destination is implausible", (_name, overrides) => {
    expect(classifyPhantomClick(makeAttempt({ ...overrides, destinationPlausible: false }))).toBe(
      "phantom"
    );
  });

  it.each(signals)("%s is effective when the destination is plausible", (_name, overrides) => {
    expect(classifyPhantomClick(makeAttempt({ ...overrides, destinationPlausible: true }))).toBe(
      "effective"
    );
  });

  it("a click with no signal at all stays phantom", () => {
    expect(classifyPhantomClick(makeAttempt({}))).toBe("phantom");
  });
});
