"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.judgeVerdictSchema = exports.llmCallSampleSchema = exports.llmCallFailureKindSchema = void 0;
const v4_1 = require("zod/v4");
/**
 * Re-exports of the call-capture telemetry types so the schema stays the
 * single source of truth. The lib/telemetry/call-capture module is the
 * canonical writer (it owns the schema + classifier helper); this barrel
 * makes the same types available to the judge / self-heal reader paths
 * without a redundant definition that could silently diverge.
 */
var call_capture_1 = require("../../lib/telemetry/call-capture");
Object.defineProperty(exports, "llmCallFailureKindSchema", { enumerable: true, get: function () { return call_capture_1.llmCallFailureKindSchema; } });
Object.defineProperty(exports, "llmCallSampleSchema", { enumerable: true, get: function () { return call_capture_1.llmCallSampleSchema; } });
/**
 * Per-sample verdict produced by the judge skill. Three boolean dimensions
 * plus an aggregate `pass` (all three must be true).
 */
const judgeVerdictEntrySchema = v4_1.z.object({
    callId: v4_1.z.string(),
    schemaOk: v4_1.z.boolean(),
    schemaRationale: v4_1.z.string(),
    factuallyGrounded: v4_1.z.boolean(),
    factualRationale: v4_1.z.string(),
    hallucinationFree: v4_1.z.boolean(),
    hallucinationRationale: v4_1.z.string(),
    worstOffender: v4_1.z.string().optional(),
    pass: v4_1.z.boolean(),
});
/**
 * Aggregate counts across all judged samples in a verdict file.
 */
const judgeAggregateSchema = v4_1.z.object({
    n: v4_1.z.number().int(),
    schemaPass: v4_1.z.number().int(),
    factualPass: v4_1.z.number().int(),
    hallucinationFreePass: v4_1.z.number().int(),
    overallPass: v4_1.z.number().int(),
});
/**
 * Top-level verdict file produced by the judge skill for one batch. Mirrors
 * beacon/pila's verdict-JSON shape but in Barnacle's camelCase convention.
 */
exports.judgeVerdictSchema = v4_1.z.object({
    callType: v4_1.z.string(),
    batchIndex: v4_1.z.number().int(),
    judgedAt: v4_1.z.string(),
    judgeModel: v4_1.z.string(),
    verdicts: v4_1.z.array(judgeVerdictEntrySchema),
    aggregate: judgeAggregateSchema,
});
//# sourceMappingURL=telemetry.js.map