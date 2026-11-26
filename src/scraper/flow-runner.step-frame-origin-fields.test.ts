import { describe, expect, expectTypeOf, it } from "vitest";
import type { HealingFlowStep } from "./flow-runner.js";

describe("HealingFlowStep frameOrigin / completeSelector / verifyRequest", () => {
  it("accepts the declared fields with their typed shapes", () => {
    const step: HealingFlowStep = {
      instruction: "Enter card number",
      frameOrigin: "https://pay.example.com",
      completeSelector: ".valid",
      verifyRequest: {
        urlTemplate: "/orders/{id}",
        method: "GET",
        jsonPath: "$.status",
        expect: "paid",
      },
    } as HealingFlowStep;
    expect(step.frameOrigin).toBe("https://pay.example.com");
    expect(step.verifyRequest?.method).toBe("GET");
    expectTypeOf<HealingFlowStep["frameOrigin"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<HealingFlowStep["completeSelector"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NonNullable<HealingFlowStep["verifyRequest"]>["method"]>().toEqualTypeOf<"GET" | "POST">();
  });
});
