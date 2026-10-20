import { describe, expect, it } from "vitest";

import { hasSubmitStepDomAdvanced } from "@/scraper/phantom-click";

const PRE = `40:${"Personal info first name last name ".slice(0, 36)}`;
const POST = `900:Work history employer title start date end date`;

describe("hasSubmitStepDomAdvanced", () => {
  it("credits a non-final step whose text advanced", () => {
    expect(hasSubmitStepDomAdvanced(false, PRE, POST)).toBe(true);
  });
  it("never credits a final step", () => {
    expect(hasSubmitStepDomAdvanced(true, PRE, POST)).toBe(false);
  });
  it("does not credit an unchanged page", () => {
    expect(hasSubmitStepDomAdvanced(false, PRE, PRE)).toBe(false);
  });
  it("fails closed when a signature is missing", () => {
    expect(hasSubmitStepDomAdvanced(false, undefined, POST)).toBe(false);
  });
  it("credits the settled snapshot after the body re-rendered past the first one", () => {
    const settled = `1200:Work history employer title start date end date`;
    expect(hasSubmitStepDomAdvanced(false, PRE, settled)).toBe(true);
  });
  it("does not credit a settled page that returned to the step-start text", () => {
    expect(hasSubmitStepDomAdvanced(false, PRE, `${PRE}`)).toBe(false);
  });
  it("does not credit a small inline-validation text change", () => {
    const withError = `${PRE.replace(/^40:/, "52:")}`;
    expect(hasSubmitStepDomAdvanced(false, PRE, withError)).toBe(false);
  });
  it("credits a header-only flip once the snapshot is marked settled", () => {
    const chrome = "Site header nav footer links ".repeat(10);
    const pre = { visibleTextSignature: `300:Personal info ${chrome}`, visibleTextDigest: "a" };
    const post = { visibleTextSignature: `300:Work history ${chrome}`, visibleTextDigest: "b" };
    expect(hasSubmitStepDomAdvanced(false, pre, { ...post, settled: true })).toBe(true);
    expect(hasSubmitStepDomAdvanced(true, pre, { ...post, settled: true })).toBe(false);
  });
  it("does not credit a header-only flip while the snapshot is unsettled", () => {
    const chrome = "Site header nav footer links ".repeat(10);
    const pre = { visibleTextSignature: `300:Personal info ${chrome}`, visibleTextDigest: "a" };
    const post = { visibleTextSignature: `300:Work history ${chrome}`, visibleTextDigest: "b" };
    expect(hasSubmitStepDomAdvanced(false, pre, post)).toBe(false);
    expect(hasSubmitStepDomAdvanced(false, pre, { ...post, settled: false })).toBe(false);
  });
  it("credits the step-start versus settled report pair, never on a final step", () => {
    const pre = "996:Skip to main content|Sign In|Careers Home|Back to Job Posting";
    const post = "588:Skip to main content|Settings|user@example.com|Careers Home|Candidate Home";
    expect(
      hasSubmitStepDomAdvanced(false, pre, { visibleTextSignature: post, settled: true })
    ).toBe(true);
    expect(hasSubmitStepDomAdvanced(false, pre, post)).toBe(true);
    expect(hasSubmitStepDomAdvanced(true, pre, { visibleTextSignature: post, settled: true })).toBe(
      false
    );
  });
  it("does not credit an identical settled pair", () => {
    expect(hasSubmitStepDomAdvanced(false, PRE, { visibleTextSignature: PRE, settled: true })).toBe(
      false
    );
  });
});
