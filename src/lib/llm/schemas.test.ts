import { describe, expect, it } from "vitest";

import { RECON_FLOW_STEP_SCHEMA } from "@/lib/llm/schemas";

describe("RECON_FLOW_STEP_SCHEMA", () => {
  it("defaults captchaGated to false when absent", () => {
    const parsed = RECON_FLOW_STEP_SCHEMA.parse({ step: "x" });
    expect(parsed).toMatchObject({ captchaGated: false });
  });

  it("round-trips captchaGated true alongside submitStep", () => {
    const parsed = RECON_FLOW_STEP_SCHEMA.parse({
      step: "x",
      submitStep: true,
      captchaGated: true,
    });
    expect(parsed).toMatchObject({ submitStep: true, captchaGated: true });
  });
});
