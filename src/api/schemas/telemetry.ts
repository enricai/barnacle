import { z } from "zod/v4";

/**
 * Zod schema for one LLM call sample written to the NDJSON capture sink.
 * Re-exported here so the schema stays the single source of truth for both
 * the capture sink (lib/telemetry/call-capture.ts) and the judge/self-heal skills.
 */
export const llmCallSampleSchema = z.object({
  callId: z.string(),
  callType: z.string(),
  model: z.string(),
  systemPrompt: z.string().nullable(),
  userContent: z.string(),
  responseContent: z.string().nullable(),
  parsedOk: z.boolean(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  latencyMs: z.number().nullable(),
  success: z.boolean(),
  ts: z.string(),
});

export type LlmCallSample = z.infer<typeof llmCallSampleSchema>;

/**
 * Per-sample verdict produced by the judge skill. Three boolean dimensions
 * plus an aggregate `pass` (all three must be true).
 */
const judgeVerdictEntrySchema = z.object({
  callId: z.string(),
  schemaOk: z.boolean(),
  schemaRationale: z.string(),
  factuallyGrounded: z.boolean(),
  factualRationale: z.string(),
  hallucinationFree: z.boolean(),
  hallucinationRationale: z.string(),
  worstOffender: z.string().optional(),
  pass: z.boolean(),
});

export type JudgeVerdictEntry = z.infer<typeof judgeVerdictEntrySchema>;

/**
 * Aggregate counts across all judged samples in a verdict file.
 */
const judgeAggregateSchema = z.object({
  n: z.number().int(),
  schemaPass: z.number().int(),
  factualPass: z.number().int(),
  hallucinationFreePass: z.number().int(),
  overallPass: z.number().int(),
});

export type JudgeAggregate = z.infer<typeof judgeAggregateSchema>;

/**
 * Top-level verdict file produced by the judge skill for one batch. Mirrors
 * beacon/pila's verdict-JSON shape but in Barnacle's camelCase convention.
 */
export const judgeVerdictSchema = z.object({
  callType: z.string(),
  batchIndex: z.number().int(),
  judgedAt: z.string(),
  judgeModel: z.string(),
  verdicts: z.array(judgeVerdictEntrySchema),
  aggregate: judgeAggregateSchema,
});

export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;
