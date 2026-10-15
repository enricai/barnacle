import { describe, expect, it } from "vitest";

import { hasSubmitStepDomAdvanced } from "@/scripts/recon-browser";

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
});
