import { describe, expect, it } from "vitest";
import { emitBrowserFlowTs } from "@/scripts/recon-generate";

const card = {
  step: "Type '4111111111111111' into the card number field",
  declareOnly: true,
  sensitive: "digits" as const,
  payloadField: "cardNumber",
  frameOrigin: "https://pay.example",
  completeSelector: ".is-complete",
};
const pay = {
  step: "Click the Pay button",
  declareOnly: true,
  submitStep: true,
  verifyRequest: {
    urlTemplate: `/api/orders/\${orderId}`,
    method: "GET" as const,
    jsonPath: "status",
    expect: "paid",
  },
};

function emit(flowSteps: unknown[]): string {
  return emitBrowserFlowTs({
    siteId: "t",
    pascal: "T",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    flowSteps: flowSteps as never,
  }).code;
}

describe("declared card step emission", () => {
  const out = emit([card, pay]);
  it("types the value by fixed code, never through an instruction", () => {
    expect(out).toContain("card: { value: payload.cardNumber");
    expect(out).toContain('frameOrigin: "https://pay.example"');
    expect(out).toContain('completeSelector: ".is-complete"');
    expect(out).not.toContain("4111111111111111");
    expect(out).not.toMatch(/instruction: [^\n]*cardNumber \?\?/);
  });
  it("records pre-submit durably and verifies via order data, not a model extract", () => {
    expect(out).toContain("context.recordPreSubmit");
    expect(out).toContain("verifyOrderData(");
    expect(out).not.toContain("guardedExtract(\n");
  });
  it("refuses a card step without a frameOrigin", () => {
    expect(() => emit([{ ...card, frameOrigin: undefined }, pay])).toThrow(/frameOrigin/);
  });
});
