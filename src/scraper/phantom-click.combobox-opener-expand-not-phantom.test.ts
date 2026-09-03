import { describe, expect, it } from "vitest";

import type { PhantomClickAttempt } from "@/scraper/phantom-click";
import { classifyPhantomClick } from "@/scraper/phantom-click";

const URL = "https://apply.acme.example/jobs/52270016990/apply-portal/apply";

function makeAttempt(overrides: Partial<PhantomClickAttempt>): PhantomClickAttempt {
  return {
    actResultSuccess: true,
    pre: { networkCount: 0, url: URL, bodyHtmlLength: 184186 },
    post: { networkCount: 0, url: URL, bodyHtmlLength: 184186 },
    ...overrides,
  };
}

describe("scraper/phantom-click classifyPhantomClick: combobox opener open-click", () => {
  it("classifies as effective when a recognized combobox opener's aria-owns panel opens (aria-expanded false->true) with no network/URL change and a trivial byte delta", () => {
    // Mirrors the report's "attempt 1 (act-string) produced no observable
    // effect — visible-text-changed-without-network" scenario, but the
    // clicked element is a recognized `[role="combobox"]` opener whose owned
    // option panel became present/visible — `comboboxOpenerPanelOpened`
    // (flow-runner.ts) feeds that as `elementStateChanged` here.
    const attempt = makeAttempt({
      elementStateChanged: true,
      post: { networkCount: 0, url: URL, bodyHtmlLength: 184216 },
    });
    expect(classifyPhantomClick(attempt)).toBe("effective");
  });

  it("keeps classifying a same-shaped click with no element state change as phantom", () => {
    const attempt = makeAttempt({
      post: { networkCount: 0, url: URL, bodyHtmlLength: 184216 },
    });
    expect(classifyPhantomClick(attempt)).toBe("phantom");
  });
});
