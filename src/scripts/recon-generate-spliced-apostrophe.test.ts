import { describe, expect, it } from "vitest";
import { parseFillStep } from "@/scraper/flow-runner";
import { escapeQuotedValue } from "@/scraper/quoted-spans";
import { buildStepInstructionExpr } from "@/scripts/recon-generate";

const INSTRUCTION = "Fill in the Last name field with 'Placeholder'";

function runEmitted(expr: string, payload: Record<string, string>): string {
  return new Function("payload", "escapeQuotedValue", `return ${expr};`)(
    payload,
    escapeQuotedValue
  ) as string;
}

describe("emitted instruction splice with apostrophes", () => {
  it.each(["O'Brien", "12 King's Row", "Smith'", "5'10"])(
    "parseFillStep recovers %s from the emitted expression",
    (value) => {
      const expr = buildStepInstructionExpr(INSTRUCTION, "lastName");
      const text = runEmitted(expr, { lastName: value });
      expect(parseFillStep(text)?.value).toBe(value);
    }
  );
});
