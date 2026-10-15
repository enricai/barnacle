import { describe, expect, it } from "vitest";
import { parseFillStep, parseSelectStep } from "@/scraper/flow-runner";
import { escapeQuotedValue } from "@/scraper/quoted-spans";
import { buildStepInstructionExpr } from "@/scripts/recon-generate";

const VALUES = ["O'Brien", "12 King's Row", "Smith'", "5'10"];

function runEmitted(expr: string, payload: Record<string, string>): string {
  return new Function("payload", "escapeQuotedValue", `return ${expr};`)(
    payload,
    escapeQuotedValue
  ) as string;
}

describe("spliced values with non-letter-flanked apostrophes", () => {
  it.each(VALUES)("parseFillStep returns the full value %s", (value) => {
    const expr = buildStepInstructionExpr(
      "Fill in the Last name field with 'Placeholder'",
      "lastName"
    );
    const text = runEmitted(expr, { lastName: value });
    expect(parseFillStep(text)?.value).toBe(value);
  });

  it.each(VALUES)("parseSelectStep returns the full option %s", (value) => {
    const expr = buildStepInstructionExpr(
      "Select 'Placeholder' from the 'Name' dropdown",
      "lastName"
    );
    const text = runEmitted(expr, { lastName: value });
    expect(parseSelectStep(text)?.option).toBe(value);
  });
});
