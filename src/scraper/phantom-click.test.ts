import { describe, expect, it } from "vitest";

import type { PhantomClickAttempt } from "@/scraper/phantom-click";
import { classifyPhantomClick } from "@/scraper/phantom-click";

const URL = "https://apply.appcast.io/jobs/52270016990/applyboard/apply";

function makeAttempt(overrides: Partial<PhantomClickAttempt>): PhantomClickAttempt {
  return {
    actResultSuccess: true,
    pre: { networkCount: 0, url: URL, bodyHtmlLength: 184186 },
    post: { networkCount: 0, url: URL, bodyHtmlLength: 184186 },
    ...overrides,
  };
}

describe("scraper/phantom-click classifyPhantomClick", () => {
  it.each([
    {
      name: "attempt 1 (act-string): success, 0->0 net, 184186->184186 html, no url change",
      attempt: makeAttempt({}),
      expected: "phantom",
    },
    {
      name: "attempt 2 (observe-act): success, 0->0 net, 184186->184186 html, no url change",
      attempt: makeAttempt({}),
      expected: "phantom",
    },
    {
      name: "attempt 3 (structured-click): resolver error, no checkable input reachable",
      attempt: makeAttempt({ actResultSuccess: false }),
      expected: "unresolved",
    },
    {
      name: "attempt 4 (observe-act-exclude): resolver error, observe returned no candidates",
      attempt: makeAttempt({ actResultSuccess: null }),
      expected: "unresolved",
    },
    {
      name: "attempt 5 (llm-rephrase): success, 0->0 net, +30B html only, trivial delta",
      attempt: makeAttempt({
        post: { networkCount: 0, url: URL, bodyHtmlLength: 184216 },
      }),
      expected: "phantom",
    },
  ])("$name -> $expected", ({ attempt, expected }) => {
    expect(classifyPhantomClick(attempt)).toBe(expected);
  });

  it("classifies as effective when network count increases", () => {
    const attempt = makeAttempt({
      post: { networkCount: 1, url: URL, bodyHtmlLength: 184186 },
    });
    expect(classifyPhantomClick(attempt)).toBe("effective");
  });

  it("classifies as effective when the URL changes", () => {
    const attempt = makeAttempt({
      post: { networkCount: 0, url: `${URL}?step=2`, bodyHtmlLength: 184186 },
    });
    expect(classifyPhantomClick(attempt)).toBe("effective");
  });

  it("classifies as effective when the DOM grows past the trivial-delta threshold", () => {
    const attempt = makeAttempt({
      post: { networkCount: 0, url: URL, bodyHtmlLength: 184186 + 500 },
    });
    expect(classifyPhantomClick(attempt)).toBe("effective");
  });

  it("classifies as unresolved regardless of an incidental post-snapshot effect", () => {
    const attempt = makeAttempt({
      actResultSuccess: false,
      post: { networkCount: 1, url: `${URL}?step=2`, bodyHtmlLength: 999999 },
    });
    expect(classifyPhantomClick(attempt)).toBe("unresolved");
  });
});
