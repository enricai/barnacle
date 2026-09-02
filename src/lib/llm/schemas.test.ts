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

describe("RECON_FLOW_STEP_SCHEMA emailStep marker", () => {
  it("defaults emailStep to false and leaves emailStepConfig undefined when absent", () => {
    const parsed = RECON_FLOW_STEP_SCHEMA.parse({ step: "click submit" });

    expect(parsed).toMatchObject({ emailStep: false });
    expect((parsed as { emailStepConfig?: unknown }).emailStepConfig).toBeUndefined();
  });

  it("round-trips emailStep:true with a fully-specified emailStepConfig", () => {
    const parsed = RECON_FLOW_STEP_SCHEMA.parse({
      step: "verify email",
      emailStep: true,
      emailStepConfig: {
        subjectContains: "Verify your account",
        extract: "code",
        linkPattern: "https://example.com/verify\\?token=(\\w+)",
        codePattern: "\\b\\d{6}\\b",
        action: "fill",
        timeoutMs: 60_000,
      },
    });

    expect(parsed).toMatchObject({
      emailStep: true,
      emailStepConfig: {
        subjectContains: "Verify your account",
        extract: "code",
        linkPattern: "https://example.com/verify\\?token=(\\w+)",
        codePattern: "\\b\\d{6}\\b",
        action: "fill",
        timeoutMs: 60_000,
      },
    });
  });

  it("defaults emailStepConfig.extract to link and action to navigate when omitted", () => {
    const parsed = RECON_FLOW_STEP_SCHEMA.parse({
      step: "verify email",
      emailStep: true,
      emailStepConfig: {},
    });

    expect(parsed).toMatchObject({
      emailStep: true,
      emailStepConfig: { extract: "link", action: "navigate" },
    });
  });
});
