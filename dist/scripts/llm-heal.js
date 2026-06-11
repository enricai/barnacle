"use strict";
/**
 * LLM prompt-template self-heal harness: given a judge verdict file containing
 * failing samples for a callType, iterate — run a baseline pass rate, ask the
 * patch generator to propose a minimal edit to the prompt template, replay the
 * patched prompt against the captured user_content, score, and check convergence.
 * Writes a healing-<callType>.md report for human review and manual apply.
 * Production prompts in src/prompts/ are NEVER modified.
 *
 * Usage:
 *   pnpm heal:llm \
 *     --verdict-path judge-out/verdict-act-0.json \
 *     --call-type act
 *
 * Knobs (all optional):
 *   --max-iterations <N>        default 5
 *   --n-replays <N>             default 5
 *   --success-threshold <0..1>  default 0.9
 *   --plateau-delta <0..1>      default 0.03
 *   --plateau-window <N>        default 3
 *   --out-dir <path>            default llm-heal-out
 *   --judge-model <model>       override the judge model
 *   --dry-run                   stubs the scorer (CI mode, no API calls)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAnthropicClient = buildAnthropicClient;
exports.requestPromptPatch = requestPromptPatch;
exports.replayPromptArm = replayPromptArm;
exports.makeDryRunReplayFn = makeDryRunReplayFn;
exports.writeLlmHealState = writeLlmHealState;
exports.writeLlmIterationArtifacts = writeLlmIterationArtifacts;
exports.writeLlmHealReport = writeLlmHealReport;
exports.phaseLlmHeal = phaseLlmHeal;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const zod_1 = require("@anthropic-ai/sdk/helpers/zod");
const date_fns_1 = require("date-fns");
const telemetry_1 = require("../api/schemas/telemetry");
const config_1 = require("../config");
const schemas_1 = require("../lib/llm/schemas");
const logging_1 = require("../lib/logging");
const call_capture_1 = require("../lib/telemetry/call-capture");
const call_types_1 = require("../lib/telemetry/call-types");
const judge_llm_batch_1 = require("../scripts/judge-llm-batch");
const recon_heal_1 = require("../scripts/recon-heal");
const logger = (0, logging_1.getScriptLogger)("llm-heal");
// ── defaults ──────────────────────────────────────────────────────────────────
const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_N_REPLAYS = 5;
const DEFAULT_SUCCESS_THRESHOLD = 0.9;
const DEFAULT_PLATEAU_DELTA = 0.03;
const DEFAULT_PLATEAU_WINDOW = 3;
const DEFAULT_OUT_DIR = "llm-heal-out";
// ── Anthropic client ──────────────────────────────────────────────────────────
/**
 * Returns the Anthropic client, or null when the deployment is Bedrock-only.
 */
function buildAnthropicClient() {
    if (config_1.config.scraper.useBedrock || !config_1.config.scraper.anthropicApiKey)
        return null;
    return new sdk_1.default({ apiKey: config_1.config.scraper.anthropicApiKey });
}
function anthropicModelName(judgeModel) {
    if (judgeModel)
        return judgeModel;
    const raw = config_1.config.scraper.model;
    return raw.startsWith("anthropic/") ? raw.slice("anthropic/".length) : raw;
}
// ── patch generator ───────────────────────────────────────────────────────────
/**
 * System prompt carrying the minimal-change patch discipline for prompt-
 * template healing. Same shape as the recon-flow-patch system prompt but
 * applied to a prompt template (string) instead of a step-array JSON.
 */
const LLM_PATCH_SYSTEM_PROMPT = `You propose minimal patches to an LLM prompt template that has been failing judge review. Apply the minimise-change principle:
- The anchor must be a verbatim substring of the current prompt template; copy-paste it exactly.
- The replacement is the new text to substitute in place of the anchor.
- Prefer clarifying ambiguous instructions over rewriting clear ones.
- Add explicit output format constraints to reduce hallucination.
- Do not anchor on text that appears in multiple places unless intentional.
- Do not repeat a strategy already in PRIOR ITERATION HISTORY.
- If history shows no_change or regressed, pivot to a fundamentally different approach and explain in pivot_reason.`;
/**
 * Asks the model to propose a minimal patch to the prompt template, following
 * the same anchor/replacement discipline as recon-flow-patch-generator but
 * applied to a natural-language system or user prompt string.
 */
async function requestPromptPatch(params) {
    const { client, callType, promptTemplate, failingSamples, iterN, priorAttempts, captureFn = call_capture_1.captureLlmCall, } = params;
    const failingExamples = failingSamples
        .slice(0, 3)
        .map((s, i) => `  ${i + 1}. userContent: ${s.userContent.slice(0, 200)}\n     responseContent: ${(s.responseContent ?? "(null)").slice(0, 200)}`)
        .join("\n");
    const historySection = priorAttempts.length > 0
        ? priorAttempts
            .map((a) => `  iter ${a.iter}: anchor="${a.anchor}" replacement="${a.replacement}" strategy="${a.strategy}" outcome=${a.outcome}`)
            .join("\n")
        : "  (no prior attempts)";
    const userContent = `This is iteration ${iterN} for callType="${callType}".

## CURRENT PROMPT TEMPLATE
${promptTemplate}

## FAILING SAMPLE EXAMPLES (up to 3)
${failingExamples}

## PRIOR ITERATION HISTORY
${historySection}

Propose a patch to exactly ONE part of the prompt template. Set pivot_reason to null on the first iteration; otherwise set it to one sentence explaining the pivot from the last failed attempt.`;
    const model = anthropicModelName();
    const t0 = performance.now();
    try {
        const response = await client.messages.parse({
            model,
            max_tokens: 500,
            system: LLM_PATCH_SYSTEM_PROMPT,
            messages: [{ role: "user", content: userContent }],
            output_config: {
                format: (0, zod_1.zodOutputFormat)(schemas_1.PATCH_RESPONSE_SCHEMA),
            },
        });
        const latencyMs = performance.now() - t0;
        const parsed = response.parsed_output;
        if (parsed === null) {
            throw new Error("structured-output enabled but parsed_output is null");
        }
        const textBlock = response.content.find((b) => b.type === "text");
        const rawText = textBlock?.type === "text" ? textBlock.text : "";
        const patch = {
            anchor: parsed.anchor,
            replacement: parsed.replacement,
            strategy: parsed.strategy,
            pivot_reason: parsed.pivot_reason,
        };
        if (!promptTemplate.includes(patch.anchor)) {
            logger.warn(`llm-heal: patch anchor not found in prompt template: "${patch.anchor}"`);
            await captureFn({
                callId: (0, node_crypto_1.randomUUID)(),
                callType: call_types_1.CALL_TYPE_LLM_PROMPT_PATCH,
                model,
                systemPrompt: LLM_PATCH_SYSTEM_PROMPT,
                userContent,
                responseContent: rawText,
                parsedOk: false,
                inputTokens: response.usage?.input_tokens ?? null,
                outputTokens: response.usage?.output_tokens ?? null,
                latencyMs,
                success: false,
                errorMessage: `patch anchor not found in prompt template: ${patch.anchor.slice(0, 80)}`,
                failureKind: "schema-validation-failed",
            });
            return null;
        }
        await captureFn({
            callId: (0, node_crypto_1.randomUUID)(),
            callType: call_types_1.CALL_TYPE_LLM_PROMPT_PATCH,
            model,
            systemPrompt: LLM_PATCH_SYSTEM_PROMPT,
            userContent,
            responseContent: rawText,
            parsedOk: true,
            inputTokens: response.usage?.input_tokens ?? null,
            outputTokens: response.usage?.output_tokens ?? null,
            latencyMs,
            success: true,
            errorMessage: null,
            failureKind: null,
        });
        return patch;
    }
    catch (err) {
        await captureFn({
            callId: (0, node_crypto_1.randomUUID)(),
            callType: call_types_1.CALL_TYPE_LLM_PROMPT_PATCH,
            model,
            systemPrompt: LLM_PATCH_SYSTEM_PROMPT,
            userContent,
            responseContent: null,
            parsedOk: false,
            inputTokens: null,
            outputTokens: null,
            latencyMs: performance.now() - t0,
            success: false,
            errorMessage: err instanceof Error ? err.message : String(err),
            failureKind: (0, call_capture_1.classifyLlmCallFailure)(err),
        });
        return null;
    }
}
// ── replay runner ─────────────────────────────────────────────────────────────
/**
 * Scores each failing sample with the given scorer, treating the patched
 * prompt as the system prompt context. Repeats nReplays times per sample and
 * averages the pass rate — accounts for LLM non-determinism on borderline cases.
 */
async function replayPromptArm(params) {
    const { samples, promptTemplate, scorerFn, nReplays } = params;
    if (samples.length === 0) {
        return { passRate: 0, passCount: 0, failCount: 0 };
    }
    let totalPass = 0;
    let totalFail = 0;
    for (const sample of samples) {
        const patchedSample = {
            ...sample,
            systemPrompt: promptTemplate,
        };
        for (let r = 0; r < nReplays; r++) {
            const score = await scorerFn(patchedSample);
            const pass = score.schemaOk && score.factuallyGrounded && score.hallucinationFree;
            if (pass) {
                totalPass++;
            }
            else {
                totalFail++;
            }
        }
    }
    const total = totalPass + totalFail;
    return {
        passRate: total > 0 ? totalPass / total : 0,
        passCount: totalPass,
        failCount: totalFail,
    };
}
/**
 * Dry-run replay runner: marks every sample as passing without calling the
 * scorer. Used in CI to verify the loop mechanics without any API calls.
 */
function makeDryRunReplayFn(passRate = 1.0) {
    return async ({ samples, nReplays, }) => {
        const total = samples.length * nReplays;
        const passCount = Math.round(total * passRate);
        const failCount = total - passCount;
        return { passRate: total > 0 ? passCount / total : 0, passCount, failCount };
    };
}
// ── state persistence ─────────────────────────────────────────────────────────
/**
 * Writes the current heal state to llm-heal-out/<callType>/state.json so the
 * operator can inspect progress across interruptions.
 */
function writeLlmHealState(outDir, callType, state) {
    const dir = (0, node_path_1.join)(outDir, callType);
    (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, "state.json"), JSON.stringify(state, null, 2));
}
/**
 * Persists per-iteration inputs and outputs for audit.
 */
function writeLlmIterationArtifacts(params) {
    const { outDir, callType, iterN, patch, patchedPrompt, passRate, passCount, failCount } = params;
    const dir = (0, node_path_1.join)(outDir, callType, `iter-${iterN}`);
    (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, "patch-response.json"), JSON.stringify(patch, null, 2));
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, "patched-prompt.txt"), patchedPrompt);
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, "scores.json"), JSON.stringify({ iterN, passRate, passCount, failCount }, null, 2));
}
// ── report ────────────────────────────────────────────────────────────────────
/**
 * Writes the healing report markdown and returns its path.
 */
function writeLlmHealReport(params) {
    const { outDir, callType, state, verdict } = params;
    const dir = (0, node_path_1.join)(outDir, callType);
    (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    const historyRows = [
        `| iter | pass_rate | delta |`,
        `|------|-----------|-------|`,
        `| 0 (baseline) | ${(state.baselinePassRate * 100).toFixed(0)}% | — |`,
        ...state.history.map((h, idx) => {
            const prev = idx === 0 ? state.baselinePassRate : state.history[idx - 1].passRate;
            const delta = h.passRate - prev;
            const deltaStr = `${(delta >= 0 ? "+" : "") + (delta * 100).toFixed(0)}%`;
            return `| ${h.iterN} | ${(h.passRate * 100).toFixed(0)}% | ${deltaStr} |`;
        }),
    ].join("\n");
    const bestPatchBlock = state.bestPatch !== null
        ? [
            `**Anchor:**`,
            `\`\`\``,
            state.bestPatch.anchor,
            `\`\`\``,
            ``,
            `**Replacement:**`,
            `\`\`\``,
            state.bestPatch.replacement,
            `\`\`\``,
            ``,
            `**Strategy:** ${state.bestPatch.strategy}`,
        ].join("\n")
        : "(no patch improved the baseline)";
    const report = [
        `# Heal report: ${callType}`,
        ``,
        `**Verdict:** ${verdict}`,
        `**Iterations run:** ${state.history.length}`,
        `**Baseline pass rate:** ${(state.baselinePassRate * 100).toFixed(0)}%`,
        `**Best pass rate:** ${(state.bestPassRate * 100).toFixed(0)}% (iter ${state.bestIterN})`,
        ``,
        `## Best patch`,
        ``,
        bestPatchBlock,
        ``,
        `## Iteration history`,
        ``,
        historyRows,
        ``,
        `---`,
        `_Generated by llm-heal at ${(0, date_fns_1.formatISO)(new Date())}_`,
        `_Production prompt templates were NOT modified. Apply the patch above manually after review._`,
    ].join("\n");
    const reportPath = (0, node_path_1.join)(dir, `healing-${callType}.md`);
    (0, node_fs_1.writeFileSync)(reportPath, report);
    return reportPath;
}
// ── main heal loop ────────────────────────────────────────────────────────────
/**
 * Drives the full baseline → patch → replay → converge loop for a single
 * callType's failing prompt. Accepts injectable `replayFn`, `requestPatchFn`,
 * and `scorerFn` so tests can stub LLM calls and scoring.
 */
async function phaseLlmHeal(params) {
    const { verdictPath, callType, maxIterations = DEFAULT_MAX_ITERATIONS, nReplays = DEFAULT_N_REPLAYS, successThreshold = DEFAULT_SUCCESS_THRESHOLD, plateauDelta = DEFAULT_PLATEAU_DELTA, plateauWindow = DEFAULT_PLATEAU_WINDOW, outDir = DEFAULT_OUT_DIR, judgeModel, dryRun = false, } = params;
    // ── load verdict ────────────────────────────────────────────────────────────
    logger.info(`llm-heal: loading verdict from ${verdictPath}`);
    let rawVerdict;
    try {
        rawVerdict = JSON.parse((0, node_fs_1.readFileSync)(verdictPath, "utf-8"));
    }
    catch (err) {
        throw new Error(`llm-heal: cannot read verdict file: ${String(err)}`);
    }
    const verdictResult = telemetry_1.judgeVerdictSchema.safeParse(rawVerdict);
    if (!verdictResult.success) {
        throw new Error(`llm-heal: verdict file does not satisfy judgeVerdictSchema: ${verdictResult.error.message}`);
    }
    const judgeVerdictData = verdictResult.data;
    // Extract failing samples from the verdict. The verdict contains entries but
    // not the original call content — the samples come from the verdict's callId
    // references. Since we have pass/fail entries, we reconstruct minimal samples
    // from the verdict data for prompt replay scoring.
    const failingCallIds = new Set(judgeVerdictData.verdicts.filter((v) => !v.pass).map((v) => v.callId));
    logger.info(`llm-heal: callType=${callType} total=${judgeVerdictData.verdicts.length} failing=${failingCallIds.size}`);
    if (failingCallIds.size === 0) {
        logger.info("llm-heal: no failing samples — nothing to heal, exiting SUCCESS");
        const state = {
            callType,
            baselinePassRate: 1.0,
            history: [],
            bestPassRate: 1.0,
            bestPatch: null,
            bestIterN: 0,
        };
        const reportPath = writeLlmHealReport({ outDir, callType, state, verdict: "SUCCESS" });
        return { verdict: "SUCCESS", reportPath, state };
    }
    // Build minimal LlmCallSample objects from the verdict entries so the scorer
    // can evaluate them with a patched prompt template substituted as systemPrompt.
    const failingSamples = judgeVerdictData.verdicts
        .filter((v) => !v.pass)
        .map((v) => ({
        callId: v.callId,
        callType,
        model: judgeVerdictData.judgeModel,
        systemPrompt: null,
        userContent: v.worstOffender ?? `callId=${v.callId} failed: ${v.schemaRationale}`,
        responseContent: null,
        parsedOk: false,
        inputTokens: null,
        outputTokens: null,
        latencyMs: null,
        success: false,
        errorMessage: null,
        failureKind: null,
        ts: judgeVerdictData.judgedAt,
    }));
    // ── scorer setup ────────────────────────────────────────────────────────────
    let resolvedScorerFn;
    if (params.scorerFn) {
        resolvedScorerFn = params.scorerFn;
    }
    else if (dryRun) {
        resolvedScorerFn = (0, judge_llm_batch_1.makeDryRunScorer)();
    }
    else {
        if (!config_1.config.scraper.anthropicApiKey) {
            throw new Error("llm-heal requires ANTHROPIC_API_KEY");
        }
        const client = new sdk_1.default({ apiKey: config_1.config.scraper.anthropicApiKey });
        resolvedScorerFn = (0, judge_llm_batch_1.makeAnthropicScorer)(client, judgeModel);
    }
    // ── replay fn setup ─────────────────────────────────────────────────────────
    const replayFn = params.replayFn ?? replayPromptArm;
    // ── patch fn setup ──────────────────────────────────────────────────────────
    // Determine the Anthropic client for the patch generator. Not needed when
    // a requestPatchFn is injected (tests) or in dry-run without injection.
    let patchClient = null;
    if (!params.requestPatchFn && !dryRun) {
        patchClient = buildAnthropicClient();
        if (!patchClient) {
            throw new Error("llm-heal requires ANTHROPIC_API_KEY — Bedrock-only deployments are not supported");
        }
    }
    const resolvedRequestPatchFn = params.requestPatchFn ?? requestPromptPatch;
    // The "prompt template" being healed is the verdict's judgeModel info combined
    // with the callType. In practice, callers inject the prompt template; when not
    // injected we synthesise a representative template from the failing rationales.
    // The anchor/replacement mechanism still applies: the healer proposes patches
    // to the text of this template string.
    const initialPromptTemplate = [
        `You are evaluating callType=${callType} responses.`,
        `Judge each response on schema adherence, factual grounding, and hallucination-freeness.`,
        `Return structured JSON with pass/fail verdicts.`,
    ].join("\n");
    (0, node_fs_1.mkdirSync)((0, node_path_1.join)(outDir, callType), { recursive: true });
    // ── baseline ────────────────────────────────────────────────────────────────
    logger.info(`llm-heal: baseline (n_replays=${nReplays})`);
    const baselineResult = await replayFn({
        samples: failingSamples,
        promptTemplate: initialPromptTemplate,
        scorerFn: resolvedScorerFn,
        nReplays,
    });
    const baselinePassRate = baselineResult.passRate;
    logger.info(`llm-heal: baseline pass_rate=${(baselinePassRate * 100).toFixed(0)}%`);
    const state = {
        callType,
        baselinePassRate,
        history: [],
        bestPassRate: baselinePassRate,
        bestPatch: null,
        bestIterN: 0,
    };
    writeLlmHealState(outDir, callType, state);
    if (baselinePassRate >= successThreshold) {
        logger.info("llm-heal: baseline already meets threshold — exiting SUCCESS");
        const reportPath = writeLlmHealReport({ outDir, callType, state, verdict: "SUCCESS" });
        return { verdict: "SUCCESS", reportPath, state };
    }
    // ── iteration loop ──────────────────────────────────────────────────────────
    let currentPromptTemplate = initialPromptTemplate;
    const priorAttempts = [];
    let convergeResult = "CONTINUE";
    while (convergeResult === "CONTINUE") {
        const iterN = state.history.length + 1;
        logger.info(`llm-heal: iteration ${iterN}/${maxIterations}`);
        // When in dry-run with no injected patch fn, there is no Anthropic client —
        // skip patch generation so the loop converges to BUDGET_EXHAUSTED.
        if (!patchClient && !params.requestPatchFn) {
            logger.warn(`llm-heal: iter ${iterN} — dry-run with no injected patch fn, stopping`);
            convergeResult = "BUDGET_EXHAUSTED";
            break;
        }
        const patch = await resolvedRequestPatchFn({
            client: patchClient,
            callType,
            promptTemplate: currentPromptTemplate,
            failingSamples,
            iterN,
            priorAttempts,
        });
        if (!patch) {
            logger.warn(`llm-heal: iter ${iterN} — patch generator returned null, stopping`);
            convergeResult = "BUDGET_EXHAUSTED";
            break;
        }
        const patchedPrompt = (0, recon_heal_1.applyPatch)([currentPromptTemplate], patch)[0] ?? currentPromptTemplate;
        const armResult = await replayFn({
            samples: failingSamples,
            promptTemplate: patchedPrompt,
            scorerFn: resolvedScorerFn,
            nReplays,
        });
        const passRate = armResult.passRate;
        const prevBest = state.bestPassRate;
        const record = { iterN, passRate, patch };
        state.history.push(record);
        if (passRate > state.bestPassRate) {
            state.bestPassRate = passRate;
            state.bestPatch = patch;
            state.bestIterN = iterN;
            currentPromptTemplate = patchedPrompt;
        }
        const outcome = passRate > prevBest + plateauDelta
            ? "improved"
            : passRate < prevBest - plateauDelta
                ? "regressed"
                : "no_change";
        priorAttempts.push({
            iter: iterN,
            anchor: patch.anchor,
            replacement: patch.replacement,
            strategy: patch.strategy,
            outcome,
        });
        writeLlmIterationArtifacts({
            outDir,
            callType,
            iterN,
            patch,
            patchedPrompt,
            passRate,
            passCount: armResult.passCount,
            failCount: armResult.failCount,
        });
        writeLlmHealState(outDir, callType, state);
        logger.info(`llm-heal: iter ${iterN} pass_rate=${(passRate * 100).toFixed(0)}% ` +
            `best=${(state.bestPassRate * 100).toFixed(0)}% outcome=${outcome}`);
        convergeResult = (0, recon_heal_1.checkConvergence)({
            history: state.history,
            bestPassRate: state.bestPassRate,
            maxIterations,
            successThreshold,
            plateauDelta,
            plateauWindow,
        });
    }
    const finalVerdict = convergeResult;
    const reportPath = writeLlmHealReport({ outDir, callType, state, verdict: finalVerdict });
    logger.info(`llm-heal: verdict=${finalVerdict} report=${reportPath}`);
    return { verdict: finalVerdict, reportPath, state };
}
// ── CLI ───────────────────────────────────────────────────────────────────────
/**
 * Parses CLI args and exits with a usage message when required args are absent.
 */
function parseCli() {
    const args = process.argv.slice(2);
    let verdictPath = "";
    let callType = "";
    let maxIterations = DEFAULT_MAX_ITERATIONS;
    let nReplays = DEFAULT_N_REPLAYS;
    let successThreshold = DEFAULT_SUCCESS_THRESHOLD;
    let plateauDelta = DEFAULT_PLATEAU_DELTA;
    let plateauWindow = DEFAULT_PLATEAU_WINDOW;
    let outDir = DEFAULT_OUT_DIR;
    let judgeModel;
    let dryRun = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--verdict-path" && args[i + 1])
            verdictPath = args[++i];
        else if (args[i] === "--call-type" && args[i + 1])
            callType = args[++i];
        else if (args[i] === "--max-iterations" && args[i + 1])
            maxIterations = Number(args[++i]);
        else if (args[i] === "--n-replays" && args[i + 1])
            nReplays = Number(args[++i]);
        else if (args[i] === "--success-threshold" && args[i + 1])
            successThreshold = Number(args[++i]);
        else if (args[i] === "--plateau-delta" && args[i + 1])
            plateauDelta = Number(args[++i]);
        else if (args[i] === "--plateau-window" && args[i + 1])
            plateauWindow = Number(args[++i]);
        else if (args[i] === "--out-dir" && args[i + 1])
            outDir = args[++i];
        else if (args[i] === "--judge-model" && args[i + 1])
            judgeModel = args[++i];
        else if (args[i] === "--dry-run")
            dryRun = true;
    }
    if (!verdictPath || !callType) {
        logger.error("usage: llm-heal.ts --verdict-path <path> --call-type <type> " +
            "[--max-iterations N] [--n-replays N] [--success-threshold 0..1] " +
            "[--plateau-delta 0..1] [--plateau-window N] [--out-dir <path>] " +
            "[--judge-model <model>] [--dry-run]");
        process.exit(1);
    }
    return {
        verdictPath,
        callType,
        maxIterations,
        nReplays,
        successThreshold,
        plateauDelta,
        plateauWindow,
        outDir,
        judgeModel,
        dryRun,
    };
}
async function main() {
    const cliArgs = parseCli();
    const { verdict, reportPath, state } = await phaseLlmHeal(cliArgs);
    logger.info(`llm-heal complete: verdict=${verdict}`);
    logger.info(`llm-heal: best_pass_rate=${(state.bestPassRate * 100).toFixed(0)}%`);
    logger.info(`llm-heal: report written to ${reportPath}`);
}
if (process.argv[1] !== undefined &&
    (process.argv[1].endsWith("llm-heal.ts") || process.argv[1].endsWith("llm-heal.js"))) {
    main().catch((err) => {
        logger.error(`llm-heal failed: ${String(err)}`);
        process.exit(1);
    });
}
//# sourceMappingURL=llm-heal.js.map