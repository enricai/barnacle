import { describe, expect, it } from "vitest";

import { denormalizeStep, normalizeFlow } from "@/scripts/recon-browser";

describe("denormalizeStep — frameOrigin / completeSelector / verifyRequest", () => {
  it("round-trips the declared fields through normalizeFlow", () => {
    const verifyRequest = {
      urlTemplate: "https://x.test/api/{id}",
      method: "POST" as const,
      jsonPath: "$.status",
      expect: "ok",
    };
    const norm = normalizeFlow([
      {
        step: "Pay",
        frameOrigin: "https://pay.test",
        completeSelector: "#done",
        verifyRequest,
      },
    ] as never);
    expect(denormalizeStep(norm[0]!)).toEqual({
      step: "Pay",
      frameOrigin: "https://pay.test",
      completeSelector: "#done",
      verifyRequest,
    });
  });
});
