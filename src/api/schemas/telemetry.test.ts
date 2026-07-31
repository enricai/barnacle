import { describe, expect, it } from "vitest";

import {
  type JudgeVerdict,
  judgeVerdictSchema,
  type LlmCallSample,
  llmCallSampleSchema,
} from "@/api/schemas/telemetry";

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeValidSample(): LlmCallSample {
  return {
    callId: "call-abc-001",
    callType: "act",
    model: "anthropic/claude-sonnet-4-6",
    systemPrompt: "You are a browser automation agent.",
    userContent: "Click the login button.",
    responseContent: '{"success": true}',
    parsedOk: true,
    inputTokens: 42,
    outputTokens: 8,
    latencyMs: 312,
    success: true,
    errorMessage: null,
    failureKind: null,
    ts: "2026-05-30T10:00:00.000Z",
  };
}

function makeValidVerdict(): JudgeVerdict {
  return {
    callType: "act",
    batchIndex: 0,
    judgedAt: "2026-05-30T11:00:00.000Z",
    judgeModel: "claude-opus-4-8",
    verdicts: [
      {
        callId: "call-abc-001",
        schemaOk: true,
        schemaRationale: "Response contains all required fields.",
        factuallyGrounded: true,
        factualRationale: "Claims are supported by the input.",
        hallucinationFree: true,
        hallucinationRationale: "No fabricated symbols detected.",
        pass: true,
      },
    ],
    aggregate: {
      n: 1,
      schemaPass: 1,
      factualPass: 1,
      hallucinationFreePass: 1,
      overallPass: 1,
    },
  };
}

// ── llmCallSampleSchema ───────────────────────────────────────────────────────

describe("llmCallSampleSchema", () => {
  it("parses a valid sample", () => {
    const result = llmCallSampleSchema.safeParse(makeValidSample());
    expect(result.success).toBe(true);
  });

  it("exposes callType, model, parsedOk, and ts on the parsed value", () => {
    const sample = llmCallSampleSchema.parse(makeValidSample());
    expect(sample.callType).toBe("act");
    expect(sample.model).toBe("anthropic/claude-sonnet-4-6");
    expect(sample.parsedOk).toBe(true);
    expect(typeof sample.ts).toBe("string");
  });

  it("accepts null for nullable fields", () => {
    const input = {
      ...makeValidSample(),
      systemPrompt: null,
      responseContent: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
    };
    const result = llmCallSampleSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects a sample missing a required field", () => {
    const { callId: _omit, ...incomplete } = makeValidSample();
    const result = llmCallSampleSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  it("rejects a sample with wrong field type", () => {
    const result = llmCallSampleSchema.safeParse({
      ...makeValidSample(),
      parsedOk: "yes",
    });
    expect(result.success).toBe(false);
  });
});

// ── judgeVerdictSchema ────────────────────────────────────────────────────────

describe("judgeVerdictSchema", () => {
  it("parses a valid verdict", () => {
    const result = judgeVerdictSchema.safeParse(makeValidVerdict());
    expect(result.success).toBe(true);
  });

  it("exposes verdicts[] with all dimensional booleans and pass", () => {
    const verdict = judgeVerdictSchema.parse(makeValidVerdict());
    const entry = verdict.verdicts[0];
    if (!entry) throw new Error("expected at least one verdict entry");
    expect(typeof entry.schemaOk).toBe("boolean");
    expect(typeof entry.factuallyGrounded).toBe("boolean");
    expect(typeof entry.hallucinationFree).toBe("boolean");
    expect(typeof entry.pass).toBe("boolean");
  });

  it("exposes aggregate with n, schemaPass, factualPass, hallucinationFreePass, overallPass", () => {
    const verdict = judgeVerdictSchema.parse(makeValidVerdict());
    expect(typeof verdict.aggregate.n).toBe("number");
    expect(typeof verdict.aggregate.schemaPass).toBe("number");
    expect(typeof verdict.aggregate.factualPass).toBe("number");
    expect(typeof verdict.aggregate.hallucinationFreePass).toBe("number");
    expect(typeof verdict.aggregate.overallPass).toBe("number");
  });

  it("accepts a verdict entry with worstOffender present", () => {
    const input = makeValidVerdict();
    const entry = input.verdicts[0];
    if (entry) {
      entry.hallucinationFree = false;
      entry.pass = false;
      entry.worstOffender = "fabricated_method()";
    }
    input.aggregate.hallucinationFreePass = 0;
    input.aggregate.overallPass = 0;
    const result = judgeVerdictSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("accepts a verdict entry without worstOffender", () => {
    const verdict = judgeVerdictSchema.parse(makeValidVerdict());
    const [entry] = verdict.verdicts;
    expect(entry?.worstOffender).toBeUndefined();
  });

  it("accepts an empty verdicts array", () => {
    const input = {
      ...makeValidVerdict(),
      verdicts: [],
      aggregate: { n: 0, schemaPass: 0, factualPass: 0, hallucinationFreePass: 0, overallPass: 0 },
    };
    const result = judgeVerdictSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects a verdict missing callType", () => {
    const { callType: _omit, ...incomplete } = makeValidVerdict();
    const result = judgeVerdictSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  it("rejects a verdict entry missing schemaOk", () => {
    const input = makeValidVerdict();
    const firstEntry = input.verdicts[0];
    if (firstEntry) {
      const { schemaOk: _omit, ...incompleteEntry } = firstEntry;
      input.verdicts[0] = incompleteEntry as typeof firstEntry;
    }
    const result = judgeVerdictSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects a verdict with wrong aggregate field type", () => {
    const result = judgeVerdictSchema.safeParse({
      ...makeValidVerdict(),
      aggregate: {
        n: "one",
        schemaPass: 1,
        factualPass: 1,
        hallucinationFreePass: 1,
        overallPass: 1,
      },
    });
    expect(result.success).toBe(false);
  });
});
