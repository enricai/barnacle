import { describe, expect, it } from "vitest";
import { classifyPhantomClick } from "./phantom-click";

const snap = (sig: string, settled?: boolean) => ({
  networkCount: 0,
  url: "https://example.test/step",
  bodyHtmlLength: 1000,
  visibleTextSignature: sig,
  settled,
});
const pre = snap(
  "996:Skip to main content|Sign In|Careers Home|Jobs Search Results Details body words here lorem ipsum dolor sit amet consectetur"
);
const postSig =
  "588:Skip to main content|Settings|user@example.com|Careers Home|Jobs Search Results Details body words here lorem ipsum dolor sit amet";
const base = { actResultSuccess: true, destinationPlausible: true } as const;

describe("settled header-flip-and-shrink on a mid-flow submit step", () => {
  it("is effective once the page is quiescent", () => {
    expect(
      classifyPhantomClick({
        ...base,
        isMidFlowSubmitStep: true,
        isSubmitShapedStep: true,
        pre,
        post: snap(postSig, true),
      })
    ).toBe("effective");
  });
  it("stays phantom while unsettled", () => {
    expect(
      classifyPhantomClick({
        ...base,
        isMidFlowSubmitStep: true,
        isSubmitShapedStep: true,
        pre,
        post: snap(postSig, false),
      })
    ).toBe("phantom");
  });
  it("stays phantom on a final submit step", () => {
    expect(
      classifyPhantomClick({ ...base, isSubmitShapedStep: true, pre, post: snap(postSig, true) })
    ).toBe("phantom");
  });
});
