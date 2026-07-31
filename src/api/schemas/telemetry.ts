import { z } from "zod/v4";

/**
 * Re-exports of the call-capture telemetry types so the schema stays the
 * single source of truth. The lib/telemetry/call-capture module is the
 * canonical writer (it owns the schema + classifier helper); this barrel
 * makes the same types available to the judge / self-heal reader paths
 * without a redundant definition that could silently diverge.
 */
export {
  type LlmCallFailureKind,
  type LlmCallSample,
  llmCallFailureKindSchema,
  llmCallSampleSchema,
} from "@/lib/telemetry/call-capture";

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
