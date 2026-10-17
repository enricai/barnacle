import { describe, expect, it } from "vitest";

import type { PhantomClickAttempt } from "@/scraper/phantom-click";
import {
  classifyPhantomClick,
  hasPageAdvanced,
  hasPageBodySwapped,
  isPlausibleStepDestination,
  SIGN_IN_PATTERNS,
} from "@/scraper/phantom-click";

const URL = "https://apply.acme.example/jobs/52270016990/apply-portal/apply";

function makeAttempt(overrides: Partial<PhantomClickAttempt>): PhantomClickAttempt {
  return {
    actResultSuccess: true,
    pre: { networkCount: 0, url: URL, bodyHtmlLength: 184186 },
    post: { networkCount: 0, url: URL, bodyHtmlLength: 184186 },
    destinationPlausible: true,
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

  it("classifies as effective when the URL's origin or path changes", () => {
    const attempt = makeAttempt({
      post: {
        networkCount: 0,
        url: "https://apply.acme.example/jobs/confirmation",
        bodyHtmlLength: 184186,
      },
    });
    expect(classifyPhantomClick(attempt)).toBe("effective");
  });

  it("classifies as phantom when only the URL's query string changes", () => {
    const attempt = makeAttempt({
      post: { networkCount: 0, url: `${URL}?step=2`, bodyHtmlLength: 184186 },
    });
    expect(classifyPhantomClick(attempt)).toBe("phantom");
  });

  it("classifies as effective when the DOM grows past the trivial-delta threshold", () => {
    const attempt = makeAttempt({
      post: { networkCount: 0, url: URL, bodyHtmlLength: 184186 + 500 },
    });
    expect(classifyPhantomClick(attempt)).toBe("effective");
  });

  it("classifies as effective when the DOM shrinks past the trivial-delta threshold (magnitude, not growth-only)", () => {
    const attempt = makeAttempt({
      post: { networkCount: 0, url: URL, bodyHtmlLength: 184186 - 500 },
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

  // The bug report's attempt 4: a submit-shaped step whose click merely grows
  // the page body (no network, no URL, no committed element-state change)
  // must NOT be lifted to "effective" by byte growth alone — a submit needs
  // proof of a real transition, not a DOM reflow.
  it("stays phantom on a submit-shaped step with byte growth alone (no network/URL/element-state)", () => {
    const attempt = makeAttempt({
      isSubmitShapedStep: true,
      elementStateChanged: false,
      post: { networkCount: 0, url: URL, bodyHtmlLength: 184186 + 10550 },
    });
    expect(classifyPhantomClick(attempt)).toBe("phantom");
  });

  // Mirrors urlChanged's own destinationPlausible gate: a DOM-byte-only change
  // must not count as an effect when the landed page is an implausible
  // destination for the step, same as a URL-only change would be vetoed.
  it("stays phantom on byte growth alone when destinationPlausible is false", () => {
    const attempt = makeAttempt({
      destinationPlausible: false,
      post: { networkCount: 0, url: URL, bodyHtmlLength: 184186 + 500 },
    });
    expect(classifyPhantomClick(attempt)).toBe("phantom");
  });

  it.each([{ name: "destinationPlausible true", destinationPlausible: true }])(
    "still classifies as effective on byte growth alone when $name",
    ({ destinationPlausible }) => {
      const attempt = makeAttempt({
        destinationPlausible,
        post: { networkCount: 0, url: URL, bodyHtmlLength: 184186 + 500 },
      });
      expect(classifyPhantomClick(attempt)).toBe("effective");
    }
  );
});

describe("isPlausibleStepDestination", () => {
  it("vetoes a sign-in-shaped path when the step instruction is not about signing in", () => {
    expect(
      isPlausibleStepDestination("click the Create Account button", "https://x.com/login")
    ).toBe(false);
  });

  it("credits a sign-in-shaped path when the step instruction is about signing in", () => {
    expect(isPlausibleStepDestination("click the Sign In button", "https://x.com/login")).toBe(
      true
    );
  });

  it("credits a non-sign-in-shaped path regardless of the step instruction", () => {
    expect(
      isPlausibleStepDestination("click the Create Account button", "https://x.com/register")
    ).toBe(true);
  });

  it("does not veto when the click never left its sign-in-shaped URL", () => {
    expect(
      isPlausibleStepDestination(
        "click the Create Account button",
        "https://x.com/login?step=2",
        "https://x.com/login"
      )
    ).toBe(true);
  });

  it("still vetoes a bounce from a non-sign-in page to a sign-in-shaped one", () => {
    expect(
      isPlausibleStepDestination(
        "click the Create Account button",
        "https://x.com/login",
        "https://x.com/apply"
      )
    ).toBe(false);
  });

  it("fails open on an unparseable postUrl", () => {
    expect(isPlausibleStepDestination("click the Create Account button", "not-a-url")).toBe(true);
  });

  it("vetoes a capitalized sign-in-shaped path (e.g. /SignIn) the same as a lowercase one", () => {
    expect(
      isPlausibleStepDestination("click the Create Account button", "https://x.com/SignIn")
    ).toBe(false);
  });

  it("exports SIGN_IN_PATTERNS", () => {
    expect(SIGN_IN_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("scraper/phantom-click classifyPhantomClick gates every effect signal on destinationPlausible", () => {
  it.each([
    {
      name: "networkDelta",
      overrides: { post: { networkCount: 3, url: URL, bodyHtmlLength: 184186 } },
    },
    { name: "elementStateChanged", overrides: { elementStateChanged: true } },
    {
      name: "urlChanged",
      overrides: { post: { networkCount: 0, url: `${URL}/next`, bodyHtmlLength: 184186 } },
    },
  ])(
    "is phantom on $name when destinationPlausible is false, effective when true",
    ({ overrides }) => {
      expect(classifyPhantomClick(makeAttempt({ ...overrides, destinationPlausible: false }))).toBe(
        "phantom"
      );
      expect(classifyPhantomClick(makeAttempt({ ...overrides, destinationPlausible: true }))).toBe(
        "effective"
      );
    }
  );
});

describe("scraper/phantom-click mid-flow submit-shaped advance", () => {
  const advanced = {
    pre: {
      networkCount: 0,
      url: URL,
      bodyHtmlLength: 31284,
      visibleTextSignature: `996:${"a".repeat(200)}`,
    },
    post: {
      networkCount: 0,
      url: URL,
      bodyHtmlLength: 29300,
      visibleTextSignature: `588:${"b".repeat(200)}`,
    },
    isSubmitShapedStep: true,
  };

  it("credits a mid-flow submit whose page demonstrably advanced", () => {
    expect(classifyPhantomClick(makeAttempt({ ...advanced, isMidFlowSubmitStep: true }))).toBe(
      "effective"
    );
  });

  it("stays phantom for the final submit with the same pre/post", () => {
    expect(classifyPhantomClick(makeAttempt(advanced))).toBe("phantom");
  });

  it("credits a text swap with an unchanged html size", () => {
    const swap = {
      ...advanced,
      post: {
        ...advanced.post,
        bodyHtmlLength: advanced.pre.bodyHtmlLength,
        visibleTextSignature: `996:${"b".repeat(200)}`,
      },
    };
    expect(classifyPhantomClick(makeAttempt({ ...swap, isMidFlowSubmitStep: true }))).toBe(
      "effective"
    );
  });

  it("stays phantom on an unchanged signature or a small mostly-shared text delta", () => {
    const same = {
      ...advanced,
      post: { ...advanced.post, visibleTextSignature: advanced.pre.visibleTextSignature },
    };
    expect(classifyPhantomClick(makeAttempt({ ...same, isMidFlowSubmitStep: true }))).toBe(
      "phantom"
    );
    const tooltip = {
      pre: {
        ...advanced.pre,
        visibleTextSignature: "300:Create your account enter your email and password below",
      },
      post: {
        ...advanced.post,
        visibleTextSignature: "320:Create your account enter your email and password below",
      },
      isSubmitShapedStep: true,
    };
    expect(classifyPhantomClick(makeAttempt({ ...tooltip, isMidFlowSubmitStep: true }))).toBe(
      "phantom"
    );
    const reflow = {
      ...tooltip,
      pre: { ...tooltip.pre, visibleTextSignature: "77:  Details       " },
      post: { ...tooltip.post, visibleTextSignature: "47:  Details" },
    };
    expect(classifyPhantomClick(makeAttempt({ ...reflow, isMidFlowSubmitStep: true }))).toBe(
      "phantom"
    );
  });

  it("stays phantom when the destination is implausible", () => {
    expect(
      classifyPhantomClick(
        makeAttempt({ ...advanced, isMidFlowSubmitStep: true, destinationPlausible: false })
      )
    ).toBe("phantom");
  });
});

describe("scraper/phantom-click report snapshot pair", () => {
  const pre = {
    networkCount: 0,
    url: URL,
    bodyHtmlLength: 31284,
    visibleTextSignature: "996:Skip to main content|Sign In|Careers Home|Back to Job Posting",
  };
  const post = {
    networkCount: 0,
    url: URL,
    bodyHtmlLength: 29300,
    visibleTextSignature:
      "588:Skip to main content|Settings|user@example.com|Careers Home|Candidate Home",
  };
  const attempt = { pre, post, isSubmitShapedStep: true };

  it("hasPageAdvanced credits the shrinking signed-in chrome swap", () => {
    expect(hasPageAdvanced(pre, post)).toBe(true);
  });

  it("hasPageAdvanced credits a text-growing variant with different labels", () => {
    const grown = {
      ...post,
      visibleTextSignature:
        "1204:Skip to main content|Review|Education|Experience|Submit Application",
    };
    expect(hasPageAdvanced(pre, grown)).toBe(true);
  });

  it("hasPageAdvanced rejects tooltip-sized noise, identical and missing signatures", () => {
    const base = { ...pre, visibleTextSignature: "300:Create your account enter your email" };
    const noisy = { ...base, visibleTextSignature: "320:Create your account enter your email" };
    expect(hasPageAdvanced(base, noisy)).toBe(false);
    expect(hasPageAdvanced(pre, pre)).toBe(false);
    expect(hasPageAdvanced(pre, { ...post, visibleTextSignature: undefined })).toBe(false);
  });

  it("is not phantom for a mid-flow submit step", () => {
    expect(classifyPhantomClick(makeAttempt({ ...attempt, isMidFlowSubmitStep: true }))).toBe(
      "effective"
    );
  });

  it("is not phantom for a growth variant with different labels", () => {
    const grown = {
      ...post,
      bodyHtmlLength: 40000,
      visibleTextSignature:
        "1204:Skip to main content|Review|Education|Experience|Submit Application",
    };
    expect(
      classifyPhantomClick(makeAttempt({ ...attempt, post: grown, isMidFlowSubmitStep: true }))
    ).toBe("effective");
  });

  it("treats isMidFlowSubmitStep as submit-shaped on its own, crediting the advance", () => {
    expect(classifyPhantomClick(makeAttempt({ pre, post, isMidFlowSubmitStep: true }))).toBe(
      "effective"
    );
  });

  it("does not let a mid-flow submit ride a byte-only reflow", () => {
    const reflow = {
      ...post,
      bodyHtmlLength: 40000,
      visibleTextSignature: pre.visibleTextSignature,
    };
    expect(
      classifyPhantomClick(makeAttempt({ pre, post: reflow, isMidFlowSubmitStep: true }))
    ).toBe("phantom");
  });

  it("keeps the final-step verdict phantom when isMidFlowSubmitStep is false", () => {
    expect(classifyPhantomClick(makeAttempt({ ...attempt, isMidFlowSubmitStep: false }))).toBe(
      "phantom"
    );
  });

  it("stays phantom for an identical-snapshot no-op mid-flow", () => {
    expect(
      classifyPhantomClick(
        makeAttempt({ pre, post: { ...pre }, isSubmitShapedStep: true, isMidFlowSubmitStep: true })
      )
    ).toBe("phantom");
  });
});

describe("hasPageAdvanced head swap", () => {
  const snap = (
    sig: string
  ): {
    networkCount: number;
    url: string;
    bodyHtmlLength: number;
    visibleTextSignature: string;
  } => ({
    networkCount: 0,
    url: URL,
    bodyHtmlLength: 1000,
    visibleTextSignature: sig,
  });
  const chrome = "Home Jobs Careers Help Contact Footer Privacy Terms";

  it("credits a header swap under shared chrome", () => {
    expect(
      hasPageAdvanced(
        snap(`300:${chrome} Personal Information`),
        snap(`300:${chrome} Work Experience`)
      )
    ).toBe(true);
  });

  it("credits a header swap whose single new word is already in the shared chrome", () => {
    expect(
      hasPageAdvanced(
        snap(`300:Sign In Create Account Email Address ${chrome}`),
        snap(`300:My Account Create Account Email Address ${chrome}`)
      )
    ).toBe(true);
  });

  it("does not credit a single-word change under shared chrome", () => {
    expect(hasPageAdvanced(snap(`300:${chrome} Required`), snap(`300:${chrome} Invalid`))).toBe(
      false
    );
  });
});

describe("hasPageBodySwapped", () => {
  const snap = (
    sig: string
  ): {
    networkCount: number;
    url: string;
    bodyHtmlLength: number;
    visibleTextSignature: string;
  } => ({
    networkCount: 0,
    url: URL,
    bodyHtmlLength: 1000,
    visibleTextSignature: sig,
  });
  const chrome = "Home Jobs Careers Help Contact Footer Privacy Terms";

  it("does not count a header-only flip over shared chrome as a finished swap", () => {
    const pre = snap(`300:Sign In Create Account Email Address ${chrome}`);
    const post = snap(`300:My Account Create Account Email Address ${chrome}`);
    expect(hasPageAdvanced(pre, post)).toBe(true);
    expect(hasPageBodySwapped(pre, post)).toBe(false);
  });

  it("counts a substantial length change as a finished swap in either direction", () => {
    expect(hasPageBodySwapped(snap(`996:Sign In ${chrome}`), snap(`588:Sign In ${chrome}`))).toBe(
      true
    );
    expect(hasPageBodySwapped(snap(`120:Sign In ${chrome}`), snap(`1500:Sign In ${chrome}`))).toBe(
      true
    );
  });

  it("counts a head whose words were mostly replaced as a finished swap", () => {
    expect(
      hasPageBodySwapped(
        snap("300:Email Address Password Verify New Password Create Account"),
        snap("300:Welcome aboard verify your inbox to continue")
      )
    ).toBe(true);
  });

  it("does not count unchanged text", () => {
    expect(hasPageBodySwapped(snap(`300:${chrome}`), snap(`300:${chrome}`))).toBe(false);
  });
});

describe("scraper/phantom-click advance predicate on literal signatures", () => {
  const chrome = "Skip to main content|Careers Home|Search|Help|Privacy|Terms";
  const half = `996:Skip to main content|Sign In|Careers Home|Search|Help|Privacy|Terms`;
  const finished = `588:Skip to main content|Settings|user@example.com|Careers Home|Search|Help|Privacy|Terms`;
  const grown = `1500:Skip to main content|Settings|user@example.com|Careers Home|Search|Help|Privacy|Terms`;
  const snap = (
    sig: string,
    bodyHtmlLength = 1000
  ): {
    networkCount: number;
    url: string;
    bodyHtmlLength: number;
    visibleTextSignature: string;
  } => ({ networkCount: 0, url: URL, bodyHtmlLength, visibleTextSignature: sig });
  const midFlow = { isSubmitShapedStep: true, isMidFlowSubmitStep: true };

  it("treats a header-only flip as advanced but not a finished swap", () => {
    const pre = snap(`300:Sign In|Create Account|${chrome}`);
    const post = snap(`300:My Account|Create Account|${chrome}`);
    expect(hasPageAdvanced(pre, post)).toBe(true);
    expect(hasPageBodySwapped(pre, post)).toBe(false);
  });

  it("treats a shrinking body swap as a finished swap", () => {
    expect(hasPageBodySwapped(snap(half), snap(finished))).toBe(true);
  });

  it("treats a growing body swap as a finished swap", () => {
    expect(hasPageBodySwapped(snap(`588:Sign In|${chrome}`), snap(grown))).toBe(true);
  });

  it("credits a finished swap and a growth swap on a mid-flow submit step", () => {
    expect(
      classifyPhantomClick(makeAttempt({ pre: snap(half), post: snap(finished), ...midFlow }))
    ).toBe("effective");
    expect(
      classifyPhantomClick(makeAttempt({ pre: snap(finished), post: snap(grown), ...midFlow }))
    ).toBe("effective");
  });

  it("does not credit a submit-shaped click with identical signatures", () => {
    expect(
      classifyPhantomClick(makeAttempt({ pre: snap(half), post: snap(half), ...midFlow }))
    ).toBe("phantom");
    expect(hasPageAdvanced(snap(half), snap(half))).toBe(false);
  });

  it("does not credit a tooltip-sized text change", () => {
    const pre = snap(`300:Create your account|${chrome}`);
    const post = snap(`320:Create your account|${chrome}`);
    expect(hasPageAdvanced(pre, post)).toBe(false);
  });

  it("still credits a non-submit click with a large DOM reveal and no text change", () => {
    expect(
      classifyPhantomClick(makeAttempt({ pre: snap(half, 1000), post: snap(half, 9000) }))
    ).toBe("effective");
  });
});

describe("scraper/phantom-click full-text page advance", () => {
  const chrome =
    "Home Jobs Careers Benefits Locations Teams Students Veterans Events Blog Press. ".repeat(4);
  const sig = `600:${chrome.slice(0, 200)}`;
  const base = { networkCount: 0, url: URL, bodyHtmlLength: 1000, visibleTextSignature: sig };

  it("credits a body swapped past the signature head when length and head are unchanged", () => {
    const pre = {
      ...base,
      visibleText: `${chrome}Email Password Verify Password Terms Create Account`,
      visibleTextDigest: "a:1",
    };
    const post = {
      ...base,
      visibleText: `${chrome}Welcome aboard check inbox confirm address Continue`,
      visibleTextDigest: "b:1",
    };
    expect(hasPageAdvanced(pre, post)).toBe(true);
    expect(hasPageBodySwapped(pre, post)).toBe(true);
  });

  it("does not credit a digest move whose words are identical", () => {
    const text = `${chrome}Email Password`;
    const pre = { ...base, visibleText: text, visibleTextDigest: "a:1" };
    const post = {
      ...base,
      visibleText: text.split(" ").reverse().join(" "),
      visibleTextDigest: "b:1",
    };
    expect(hasPageAdvanced(pre, post)).toBe(false);
  });

  it("does not credit a single validation line appearing past the head", () => {
    const pre = { ...base, visibleText: `${chrome}Email Password`, visibleTextDigest: "a:1" };
    const post = {
      ...base,
      visibleText: `${chrome}Email Password Required field`,
      visibleTextDigest: "b:1",
    };
    expect(hasPageAdvanced(pre, post)).toBe(false);
  });
});
