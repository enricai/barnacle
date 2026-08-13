import { describe, expect, it } from "vitest";

import type { PhantomClickAttempt } from "@/scraper/phantom-click";
import { classifyPhantomClick } from "@/scraper/phantom-click";

const URL = "https://apply.acme.example/jobs/52270016990/apply-portal/apply";

// The production selectionStateSignature is an opaque `<fnv1a-hash>:<count>`
// string (see DOM_SNAPSHOT_EXPR in flow-runner.ts). classifyPhantomClick only
// compares pre vs post for inequality, so these fixtures use realistic-shape
// opaque values; a differing pair means "a selection flipped".
const STATE = "1a2b3c:4";

function makeAttempt(overrides: Partial<PhantomClickAttempt>): PhantomClickAttempt {
  return {
    actResultSuccess: true,
    pre: { networkCount: 0, url: URL, bodyHtmlLength: 184186, selectionStateSignature: STATE },
    post: { networkCount: 0, url: URL, bodyHtmlLength: 184186, selectionStateSignature: STATE },
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
      post: {
        networkCount: 1,
        url: `${URL}?step=2`,
        bodyHtmlLength: 999999,
        selectionStateSignature: "changed",
      },
    });
    expect(classifyPhantomClick(attempt)).toBe("unresolved");
  });

  // A React/SPA multi-select toggle flips a selection-state signature with no
  // network, no URL change, and a trivial or NEGATIVE byte delta — the exact
  // signature measured against real Radix/MUI/ARIA-APG toggle patterns. These
  // must classify as effective, not phantom.
  it.each([
    {
      name: "aria-pressed flip (signature changes), +30B html, no net/url",
      attempt: makeAttempt({
        pre: {
          networkCount: 0,
          url: URL,
          bodyHtmlLength: 184186,
          selectionStateSignature: "aaa:5",
        },
        post: {
          networkCount: 0,
          url: URL,
          bodyHtmlLength: 184216,
          selectionStateSignature: "bbb:5",
        },
      }),
    },
    {
      name: "selected class added (signature changes), NEGATIVE byte delta",
      attempt: makeAttempt({
        pre: {
          networkCount: 0,
          url: URL,
          bodyHtmlLength: 184186,
          selectionStateSignature: "ccc:5",
        },
        post: {
          networkCount: 0,
          url: URL,
          bodyHtmlLength: 184173,
          selectionStateSignature: "ddd:5",
        },
      }),
    },
    {
      name: "toggle reveals a sub-question (a new selection control raises the count)",
      attempt: makeAttempt({
        pre: {
          networkCount: 0,
          url: URL,
          bodyHtmlLength: 184186,
          selectionStateSignature: "eee:5",
        },
        post: {
          networkCount: 0,
          url: URL,
          bodyHtmlLength: 184200,
          selectionStateSignature: "fff:6",
        },
      }),
    },
  ])("classifies as effective on a state-toggle: $name", ({ attempt }) => {
    expect(classifyPhantomClick(attempt)).toBe("effective");
  });

  it("stays phantom when the selection-state signature is unchanged and byte delta is trivial", () => {
    const attempt = makeAttempt({
      post: { networkCount: 0, url: URL, bodyHtmlLength: 184216, selectionStateSignature: STATE },
    });
    expect(classifyPhantomClick(attempt)).toBe("phantom");
  });

  it("stays unresolved when act failed even if the selection-state changed", () => {
    const attempt = makeAttempt({
      actResultSuccess: false,
      post: { networkCount: 0, url: URL, bodyHtmlLength: 184186, selectionStateSignature: "zzz:5" },
    });
    expect(classifyPhantomClick(attempt)).toBe("unresolved");
  });

  it("does not credit a state change when one side lacks the signature (older snapshot)", () => {
    const attempt = makeAttempt({
      pre: { networkCount: 0, url: URL, bodyHtmlLength: 184186 },
      post: { networkCount: 0, url: URL, bodyHtmlLength: 184186, selectionStateSignature: "zzz:5" },
    });
    expect(classifyPhantomClick(attempt)).toBe("phantom");
  });

  // On a submit-shaped step, a stray selection-state change must NOT lift the
  // verdict off "phantom": the cascade's escalation to the deep submit locator
  // keys on a "phantom" verdict, so a validation re-render (or the submit
  // button toggling its own aria-pressed) must not mask a real submit failure.
  it("stays phantom on a submit-shaped step even when selection state changed", () => {
    const attempt = makeAttempt({
      isSubmitShapedStep: true,
      pre: { networkCount: 0, url: URL, bodyHtmlLength: 184186, selectionStateSignature: "ggg:5" },
      post: { networkCount: 0, url: URL, bodyHtmlLength: 184186, selectionStateSignature: "hhh:5" },
    });
    expect(classifyPhantomClick(attempt)).toBe("phantom");
  });

  it("still credits a submit-shaped step that produced a REAL effect (network fired)", () => {
    const attempt = makeAttempt({
      isSubmitShapedStep: true,
      post: { networkCount: 1, url: URL, bodyHtmlLength: 184186, selectionStateSignature: STATE },
    });
    expect(classifyPhantomClick(attempt)).toBe("effective");
  });
});
