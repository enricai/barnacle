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
      elementStateChanged: true,
      post: {
        networkCount: 1,
        url: `${URL}?step=2`,
        bodyHtmlLength: 999999,
      },
    });
    expect(classifyPhantomClick(attempt)).toBe("unresolved");
  });

  // The authoritative, element-scoped signal: `verifyDomEffect` read the
  // RESOLVED element's own committed-state delta (Base Web `kind`/class flip,
  // ARIA, native checked) — a design-system toggle registers with no network,
  // no URL change, and a trivial or NEGATIVE byte delta the byte floor misses.
  // These must classify as effective, not phantom.
  it.each([
    {
      name: "kind/class flip on the clicked element, +30B html, no net/url",
      attempt: makeAttempt({
        elementStateChanged: true,
        post: { networkCount: 0, url: URL, bodyHtmlLength: 184216 },
      }),
    },
    {
      name: "selected marker added, NEGATIVE byte delta",
      attempt: makeAttempt({
        elementStateChanged: true,
        post: { networkCount: 0, url: URL, bodyHtmlLength: 184173 },
      }),
    },
    {
      name: "toggle registers with an exactly-flat byte delta",
      attempt: makeAttempt({
        elementStateChanged: true,
        post: { networkCount: 0, url: URL, bodyHtmlLength: 184186 },
      }),
    },
  ])("classifies as effective on an element-state change: $name", ({ attempt }) => {
    expect(classifyPhantomClick(attempt)).toBe("effective");
  });

  it("stays phantom when the resolved element's state did not change and byte delta is trivial", () => {
    const attempt = makeAttempt({
      elementStateChanged: false,
      post: { networkCount: 0, url: URL, bodyHtmlLength: 184216 },
    });
    expect(classifyPhantomClick(attempt)).toBe("phantom");
  });

  it("stays phantom when elementStateChanged is unset (defaults to false)", () => {
    const attempt = makeAttempt({
      post: { networkCount: 0, url: URL, bodyHtmlLength: 184216 },
    });
    expect(classifyPhantomClick(attempt)).toBe("phantom");
  });

  it("stays unresolved when act failed even if the element state changed", () => {
    const attempt = makeAttempt({
      actResultSuccess: false,
      elementStateChanged: true,
      post: { networkCount: 0, url: URL, bodyHtmlLength: 184186 },
    });
    expect(classifyPhantomClick(attempt)).toBe("unresolved");
  });

  // On a submit-shaped step, a stray element-state change must NOT lift the
  // verdict off "phantom": the cascade's escalation to the deep submit locator
  // keys on a "phantom" verdict, so a validation re-render (or the submit
  // button toggling its own aria-pressed) must not mask a real submit failure.
  it("stays phantom on a submit-shaped step even when element state changed", () => {
    const attempt = makeAttempt({
      isSubmitShapedStep: true,
      elementStateChanged: true,
      post: { networkCount: 0, url: URL, bodyHtmlLength: 184186 },
    });
    expect(classifyPhantomClick(attempt)).toBe("phantom");
  });

  it("still credits a submit-shaped step that produced a REAL effect (network fired)", () => {
    const attempt = makeAttempt({
      isSubmitShapedStep: true,
      post: { networkCount: 1, url: URL, bodyHtmlLength: 184186 },
    });
    expect(classifyPhantomClick(attempt)).toBe("effective");
  });
});
