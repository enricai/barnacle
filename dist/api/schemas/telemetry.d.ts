import { z } from "zod/v4";
/**
 * Re-exports of the call-capture telemetry types so the schema stays the
 * single source of truth. The lib/telemetry/call-capture module is the
 * canonical writer (it owns the schema + classifier helper); this barrel
 * makes the same types available to the judge / self-heal reader paths
 * without a redundant definition that could silently diverge.
 */
export { type LlmCallFailureKind, type LlmCallSample, llmCallFailureKindSchema, llmCallSampleSchema, } from "../../lib/telemetry/call-capture";
/**
 * Per-sample verdict produced by the judge skill. Three boolean dimensions
 * plus an aggregate `pass` (all three must be true).
 */
declare const judgeVerdictEntrySchema: z.ZodObject<{
    callId: z.ZodString;
    schemaOk: z.ZodBoolean;
    schemaRationale: z.ZodString;
    factuallyGrounded: z.ZodBoolean;
    factualRationale: z.ZodString;
    hallucinationFree: z.ZodBoolean;
    hallucinationRationale: z.ZodString;
    worstOffender: z.ZodOptional<z.ZodString>;
    pass: z.ZodBoolean;
}, z.core.$strip>;
export type JudgeVerdictEntry = z.infer<typeof judgeVerdictEntrySchema>;
/**
 * Aggregate counts across all judged samples in a verdict file.
 */
declare const judgeAggregateSchema: z.ZodObject<{
    n: z.ZodNumber;
    schemaPass: z.ZodNumber;
    factualPass: z.ZodNumber;
    hallucinationFreePass: z.ZodNumber;
    overallPass: z.ZodNumber;
}, z.core.$strip>;
export type JudgeAggregate = z.infer<typeof judgeAggregateSchema>;
/**
 * Top-level verdict file produced by the judge skill for one batch. Mirrors
 * beacon/pila's verdict-JSON shape but in Barnacle's camelCase convention.
 */
export declare const judgeVerdictSchema: z.ZodObject<{
    callType: z.ZodString;
    batchIndex: z.ZodNumber;
    judgedAt: z.ZodString;
    judgeModel: z.ZodString;
    verdicts: z.ZodArray<z.ZodObject<{
        callId: z.ZodString;
        schemaOk: z.ZodBoolean;
        schemaRationale: z.ZodString;
        factuallyGrounded: z.ZodBoolean;
        factualRationale: z.ZodString;
        hallucinationFree: z.ZodBoolean;
        hallucinationRationale: z.ZodString;
        worstOffender: z.ZodOptional<z.ZodString>;
        pass: z.ZodBoolean;
    }, z.core.$strip>>;
    aggregate: z.ZodObject<{
        n: z.ZodNumber;
        schemaPass: z.ZodNumber;
        factualPass: z.ZodNumber;
        hallucinationFreePass: z.ZodNumber;
        overallPass: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;
