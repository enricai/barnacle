import { describe, expect, it } from "vitest";

import type { PhantomClickAttempt } from "@/scraper/phantom-click";
import { classifyPhantomClick, TRIVIAL_DOM_DELTA_BYTES } from "@/scraper/phantom-click";

const URL = "https://apply.acme.example/jobs/52270016990/apply-portal/apply";

function makeAttempt(overrides: Partial<PhantomClickAttempt>): PhantomClickAttempt {
  return {
    actResultSuccess: true,
    pre: { networkCount: 0, url: URL, bodyHtmlLength: 184186 },
    post: { networkCount: 0, url: URL, bodyHtmlLength: 184186 },
    ...overrides,
  };
}

// Regression coverage for the bytesChangedSignificantly branch's
// destinationPlausible gate, mirroring the urlChanged branch's existing gate
// (phantom-click.ts). Closes one of the two disjuncts feeding the n+16
// fallback's retryVerdict==="effective" credit.
describe("scraper/phantom-click classifyPhantomClick bytesChangedSignificantly destinationPlausible gate", () => {
  it.each([{ name: "destinationPlausible false", destinationPlausible: false as const }])(
    "classifies a non-submit-shaped byte-growth attempt as phantom when $name",
    ({ destinationPlausible }) => {
      const attempt = makeAttempt({
        destinationPlausible,
        post: {
          networkCount: 0,
          url: URL,
          bodyHtmlLength: 184186 + TRIVIAL_DOM_DELTA_BYTES,
        },
      });
      expect(classifyPhantomClick(attempt)).toBe("phantom");
    }
  );

  it.each([
    { name: "destinationPlausible unset (today's default)", destinationPlausible: undefined },
    { name: "destinationPlausible true", destinationPlausible: true as const },
  ])(
    "still classifies the identical byte-growth attempt as effective when $name",
    ({ destinationPlausible }) => {
      const attempt = makeAttempt({
        destinationPlausible,
        post: {
          networkCount: 0,
          url: URL,
          bodyHtmlLength: 184186 + TRIVIAL_DOM_DELTA_BYTES,
        },
      });
      expect(classifyPhantomClick(attempt)).toBe("effective");
    }
  );

  it.each([
    { name: "destinationPlausible false", destinationPlausible: false as const },
    { name: "destinationPlausible unset", destinationPlausible: undefined },
    { name: "destinationPlausible true", destinationPlausible: true as const },
  ])(
    "stays phantom on a submit-shaped step with byte growth alone regardless of $name",
    ({ destinationPlausible }) => {
      const attempt = makeAttempt({
        isSubmitShapedStep: true,
        destinationPlausible,
        post: {
          networkCount: 0,
          url: URL,
          bodyHtmlLength: 184186 + TRIVIAL_DOM_DELTA_BYTES,
        },
      });
      expect(classifyPhantomClick(attempt)).toBe("phantom");
    }
  );
});
