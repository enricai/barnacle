/**
 * Unit coverage for RECON_FLOW_STEP_SCHEMA, focused on the captchaGated
 * marker: it must default to false when absent and must not perturb the
 * parsed shape of any pre-existing hand-authored step form.
 */

import { describe, expect, it } from "vitest";

import { RECON_FLOW_STEP_SCHEMA } from "@/lib/llm/schemas";

describe("RECON_FLOW_STEP_SCHEMA captchaGated marker", () => {
  it("defaults captchaGated to false when absent from an object step", () => {
    const parsed = RECON_FLOW_STEP_SCHEMA.parse({ step: "click submit" });

    expect(parsed).toMatchObject({ captchaGated: false });
  });

  it("round-trips submitStep:true, captchaGated:true", () => {
    const parsed = RECON_FLOW_STEP_SCHEMA.parse({
      step: "click submit",
      submitStep: true,
      captchaGated: true,
    });

    expect(parsed).toMatchObject({ submitStep: true, captchaGated: true });
  });

  it("still parses a bare string step", () => {
    expect(RECON_FLOW_STEP_SCHEMA.parse("fill in name")).toBe("fill in name");
  });

  it("still parses a pre-existing object step shape unchanged", () => {
    const parsed = RECON_FLOW_STEP_SCHEMA.parse({
      step: "upload resume",
      optional: true,
      upload: true,
      submitStep: false,
      payloadField: "resume",
      targetId: "el-42",
      origin: "original",
    });

    expect(parsed).toMatchObject({
      step: "upload resume",
      optional: true,
      upload: true,
      submitStep: false,
      captchaGated: false,
      payloadField: "resume",
      targetId: "el-42",
      origin: "original",
    });
  });

  it("still parses an object step with payloadFieldNone and no captchaGated", () => {
    const parsed = RECON_FLOW_STEP_SCHEMA.parse({
      step: "select option",
      payloadFieldNone: true,
    });

    expect(parsed).toMatchObject({
      step: "select option",
      optional: false,
      upload: false,
      submitStep: false,
      captchaGated: false,
      payloadFieldNone: true,
    });
  });
});
