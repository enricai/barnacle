/**
 * Unit coverage for RECON_FLOW_STEP_SCHEMA, focused on the captchaGated
 * marker: it must default to false when absent and must not perturb the
 * parsed shape of any pre-existing hand-authored step form.
 */

import { describe, expect, it } from "vitest";

import {
  ERROR_MESSAGES_SCHEMA,
  JUDGE_VERDICT_SCHEMA,
  MODAL_PRIORITY_SCHEMA,
  PATCH_RESPONSE_SCHEMA,
  RECON_FLOW_STEP_SCHEMA,
  REPHRASE_RESPONSE_SCHEMA,
  SELECT_OPTION_SCHEMA,
  SUBMIT_VERDICT_SCHEMA,
} from "@/lib/llm/schemas";

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

describe("RECON_FLOW_STEP_SCHEMA navigateTo field", () => {
  it("round-trips navigateTo unchanged when present", () => {
    const parsed = RECON_FLOW_STEP_SCHEMA.parse({
      step: "go to the unfiltered listing",
      navigateTo: "https://example.com/list",
    });

    expect(parsed).toMatchObject({
      step: "go to the unfiltered listing",
      navigateTo: "https://example.com/list",
    });
  });

  it("leaves navigateTo undefined when omitted", () => {
    const parsed = RECON_FLOW_STEP_SCHEMA.parse({ step: "click submit" });

    expect((parsed as { navigateTo?: unknown }).navigateTo).toBeUndefined();
  });
});

describe("LLM prose fields are uncapped", () => {
  const LONG = "x".repeat(900);

  it("parses a 900-char prose field on every judge schema", () => {
    expect(
      SUBMIT_VERDICT_SCHEMA.safeParse({
        verified: true,
        network_signal: null,
        dom_signal: LONG,
        url_signal: LONG,
        rationale: LONG,
      }).success
    ).toBe(true);
    expect(SUBMIT_VERDICT_SCHEMA.safeParse({ verified: false, reason: LONG }).success).toBe(true);
    expect(
      SELECT_OPTION_SCHEMA.safeParse({ selectIndex: 0, optionIndex: 0, reason: LONG }).success
    ).toBe(true);
    expect(MODAL_PRIORITY_SCHEMA.safeParse({ priorityIndices: [0], rationale: LONG }).success).toBe(
      true
    );
    expect(
      ERROR_MESSAGES_SCHEMA.safeParse({
        messages: [{ text: LONG, fieldHint: null, severity: "error" }],
      }).success
    ).toBe(true);
    expect(
      JUDGE_VERDICT_SCHEMA.safeParse({
        schemaOk: true,
        schemaRationale: LONG,
        factuallyGrounded: true,
        factualRationale: LONG,
        hallucinationFree: true,
        hallucinationRationale: LONG,
      }).success
    ).toBe(true);
    expect(
      PATCH_RESPONSE_SCHEMA.safeParse({
        anchor: "a",
        replacement: "b",
        strategy: LONG,
        pivot_reason: null,
      }).success
    ).toBe(true);
    expect(
      REPHRASE_RESPONSE_SCHEMA.safeParse({ outcome: "impossible", reason: LONG }).success
    ).toBe(true);
  });

  it("still enforces min(1) and array count bounds", () => {
    expect(SUBMIT_VERDICT_SCHEMA.safeParse({ verified: false, reason: "" }).success).toBe(false);
    expect(
      ERROR_MESSAGES_SCHEMA.safeParse({
        messages: Array.from({ length: 51 }, () => ({
          text: "e",
          fieldHint: null,
          severity: "error",
        })),
      }).success
    ).toBe(false);
  });
});
