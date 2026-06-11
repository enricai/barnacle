"use strict";
/**
 * Recon self-heal harness: given a site whose recon flow produced terminal
 * step failures, iterate — baseline-replay the flow, ask the
 * recon-flow-patch-generator to propose a minimal patch to one step,
 * replay the patched flow, score, check convergence. Writes a
 * healing-<siteId>.md report so the human can review and manually apply
 * the best patch. The source recon-flow.json is NEVER modified.
 *
 * Usage:
 *   pnpm tsx src/scripts/recon-heal.ts \
 *     --site-id my-site \
 *     --url https://my-site.example.com
 *
 * Knobs (all optional):
 *   --max-iterations <N>        default 5
 *   --n-replays <N>             default 3 (Steel sessions are expensive)
 *   --success-threshold <0..1>  default 0.9
 *   --plateau-delta <0..1>      default 0.03
 *   --plateau-window <N>        default 3
 *   --out-dir <path>            default heal-out
 *   --dry-run                   stubs the browser runner (CI mode)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAnthropicClient = buildAnthropicClient;
exports.requestPatch = requestPatch;
exports.applyPatch = applyPatch;
exports.checkConvergence = checkConvergence;
exports.makeDryRunStepRunner = makeDryRunStepRunner;
exports.makeRealStepRunner = makeRealStepRunner;
exports.writeState = writeState;
exports.writeIterationArtifacts = writeIterationArtifacts;
exports.writeHealReport = writeHealReport;
exports.phaseHeal = phaseHeal;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const zod_1 = require("@anthropic-ai/sdk/helpers/zod");
const date_fns_1 = require("date-fns");
const config_1 = require("../config");
const http_1 = require("../lib/http");
const schemas_1 = require("../lib/llm/schemas");
const logging_1 = require("../lib/logging");
const call_capture_1 = require("../lib/telemetry/call-capture");
const call_types_1 = require("../lib/telemetry/call-types");
const errors_1 = require("../scraper/errors");
const session_1 = require("../scraper/session");
const stagehand_guard_1 = require("../scraper/stagehand-guard");
(0, http_1.configureHttpDispatcher)();
const logger = (0, logging_1.getScriptLogger)("recon-heal");
// ── defaults ──────────────────────────────────────────────────────────────────
const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_N_REPLAYS = 3;
const DEFAULT_SUCCESS_THRESHOLD = 0.9;
const DEFAULT_PLATEAU_DELTA = 0.03;
const DEFAULT_PLATEAU_WINDOW = 3;
const DEFAULT_OUT_DIR = "heal-out";
/** Warn before starting when estimated Steel+Anthropic calls exceed this. */
const COST_WARNING_THRESHOLD = 30;
// ── Anthropic client ──────────────────────────────────────────────────────────
/**
 * Returns the Anthropic client, or null when the deployment is Bedrock-only.
 * The heal loop requires the Anthropic SDK (not Bedrock) because it calls
 * claude.ai claude-code-agent-style subagent behaviour inline.
 */
function buildAnthropicClient() {
    if (config_1.config.scraper.useBedrock || !config_1.config.scraper.anthropicApiKey)
        return null;
    return new sdk_1.default({ apiKey: config_1.config.scraper.anthropicApiKey });
}
function anthropicModelName() {
    const raw = config_1.config.scraper.model;
    return raw.startsWith("anthropic/") ? raw.slice("anthropic/".length) : raw;
}
// ── patch generator ───────────────────────────────────────────────────────────
/**
 * System prompt carrying the minimal-change patch discipline. Per Anthropic
 * guidance, durable rules live in `system` so the user prompt can focus on
 * per-call data (current flow, failing steps, prior attempts).
 */
const PATCH_SYSTEM_PROMPT = `You propose minimal patches to a recon-flow JSON. Apply the minimise-change principle:
- The anchor must be a verbatim substring of one of the step strings in the current flow; copy-paste it exactly.
- The replacement is the new text to substitute in place of the anchor.
- Prefer clarifying ambiguous phrasing over rewriting a clear instruction.
- Add visible landmarks (labels, headings) to reduce selector ambiguity.
- Do not anchor on text that appears in multiple steps.
- Do not repeat a strategy already in PRIOR ITERATION HISTORY.
- If PRIOR ITERATION HISTORY shows no_change or regressed, pivot to a fundamentally different approach and explain in pivot_reason.`;
/**
 * Asks the model to propose a minimal patch to one failing step, following
 * the recon-flow-patch-generator subagent discipline: anchor is a verbatim
 * substring, replacement is the new step text.
 */
async function requestPatch(params) {
    const { client, currentFlow, failingSteps, iterN, priorAttempts, captureFn = call_capture_1.captureLlmCall, } = params;
    const flowJson = JSON.stringify(currentFlow, null, 2);
    const failingList = failingSteps.map((s, i) => `  ${i + 1}. "${s}"`).join("\n");
    const historySection = priorAttempts.length > 0
        ? priorAttempts
            .map((a) => `  iter ${a.iter}: anchor="${a.anchor}" replacement="${a.replacement}" strategy="${a.strategy}" outcome=${a.outcome}`)
            .join("\n")
        : "  (no prior attempts)";
    const prompt = `This is iteration ${iterN}.

## CURRENT FLOW JSON
${flowJson}

## FAILING STEPS (steps that terminally failed browser automation)
${failingList}

## PRIOR ITERATION HISTORY
${historySection}

Propose a patch to exactly ONE failing step. Set pivot_reason to null on the first iteration; otherwise set it to one sentence explaining the pivot from the last failed attempt.`;
    const model = anthropicModelName();
    const t0 = performance.now();
    try {
        const response = await client.messages.parse({
            model,
            max_tokens: 500,
            system: PATCH_SYSTEM_PROMPT,
            messages: [{ role: "user", content: prompt }],
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
        const anchorFound = currentFlow.some((step) => step.includes(patch.anchor));
        if (!anchorFound) {
            logger.warn(`patch anchor not found in current flow: "${patch.anchor}"`);
            await captureFn({
                callId: (0, node_crypto_1.randomUUID)(),
                callType: call_types_1.CALL_TYPE_RECON_FLOW_PATCH,
                model,
                systemPrompt: PATCH_SYSTEM_PROMPT,
                userContent: prompt,
                responseContent: rawText,
                parsedOk: false,
                inputTokens: response.usage?.input_tokens ?? null,
                outputTokens: response.usage?.output_tokens ?? null,
                latencyMs,
                success: false,
                errorMessage: `patch anchor not found in current flow: ${patch.anchor.slice(0, 80)}`,
                failureKind: "schema-validation-failed",
            });
            return null;
        }
        await captureFn({
            callId: (0, node_crypto_1.randomUUID)(),
            callType: call_types_1.CALL_TYPE_RECON_FLOW_PATCH,
            model,
            systemPrompt: PATCH_SYSTEM_PROMPT,
            userContent: prompt,
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
            callType: call_types_1.CALL_TYPE_RECON_FLOW_PATCH,
            model,
            systemPrompt: PATCH_SYSTEM_PROMPT,
            userContent: prompt,
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
// ── patch application ─────────────────────────────────────────────────────────
/**
 * Produces a patched flow without touching the source — callers depend on the
 * original remaining unmodified so it can be safely re-used across iterations.
 */
function applyPatch(flow, patch) {
    const patched = flow.map((step) => {
        if (step.includes(patch.anchor)) {
            return step.replace(patch.anchor, patch.replacement);
        }
        return step;
    });
    return patched;
}
// ── convergence ───────────────────────────────────────────────────────────────
/**
 * Determines the convergence verdict given the current history and thresholds.
 * Checks in order: SUCCESS → REGRESSED → BUDGET_EXHAUSTED → PLATEAUED → CONTINUE.
 */
function checkConvergence(params) {
    const { history, bestPassRate, maxIterations, successThreshold, plateauDelta, plateauWindow } = params;
    if (history.length === 0)
        return "CONTINUE";
    const latest = history[history.length - 1];
    if (latest.passRate >= successThreshold)
        return "SUCCESS";
    if (history.length >= maxIterations)
        return "BUDGET_EXHAUSTED";
    if (history.length >= plateauWindow) {
        const window = history.slice(-plateauWindow);
        const allRegressed = window.every((h) => bestPassRate - h.passRate > plateauDelta);
        if (allRegressed)
            return "REGRESSED";
    }
    if (history.length >= plateauWindow) {
        const window = history.slice(-plateauWindow);
        const rates = window.map((h) => h.passRate);
        const min = Math.min(...rates);
        const max = Math.max(...rates);
        if (max - min < plateauDelta)
            return "PLATEAUED";
    }
    return "CONTINUE";
}
// ── step runner ───────────────────────────────────────────────────────────────
/**
 * Dry-run step runner: all steps pass immediately. Used in CI to avoid real
 * Steel sessions. Accepts a dry-run pass rate override for testing convergence.
 */
function makeDryRunStepRunner(passRate = 1.0) {
    return async ({ flow, }) => {
        const total = flow.length;
        const passCount = Math.round(total * passRate);
        const failCount = total - passCount;
        return { passRate: total > 0 ? passCount / total : 0, passCount, failCount };
    };
}
/**
 * Real step runner: drives recon-browser.ts against a live Steel session.
 * Each step that throws StepVerificationError counts as a failure.
 */
function makeRealStepRunner() {
    return async ({ flow, url, }) => {
        let passCount = 0;
        let failCount = 0;
        const session = await (0, session_1.createBrowserSession)();
        try {
            const page = await session.stagehand.context.awaitActivePage();
            await page.goto(url, { waitUntil: "domcontentloaded" });
            for (const step of flow) {
                try {
                    const result = await (0, stagehand_guard_1.guardedAct)(session.stagehand, step);
                    if (!result.success) {
                        failCount++;
                    }
                    else {
                        passCount++;
                    }
                }
                catch (err) {
                    if (err instanceof errors_1.StepVerificationError) {
                        failCount++;
                    }
                    else {
                        failCount++;
                    }
                }
            }
        }
        finally {
            await session.close().catch(() => undefined);
        }
        const total = flow.length;
        return {
            passRate: total > 0 ? passCount / total : 0,
            passCount,
            failCount,
        };
    };
}
// ── state persistence ─────────────────────────────────────────────────────────
/**
 * Writes the current heal state to heal-out/<siteId>/state.json so the
 * operator can inspect progress and the loop can resume across interruptions.
 */
function writeState(outDir, siteId, state) {
    const dir = (0, node_path_1.join)(outDir, siteId);
    (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, "state.json"), JSON.stringify(state, null, 2));
}
/**
 * Persists all per-iteration inputs and outputs so the operator can audit
 * exactly what the patch-generator saw and how the patched arm performed.
 */
function writeIterationArtifacts(params) {
    const { outDir, siteId, iterN, patchRequest, patch, appliedFlow, passRate, passCount, failCount, } = params;
    const dir = (0, node_path_1.join)(outDir, siteId, `iter-${iterN}`);
    (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, "patch-request.json"), JSON.stringify(patchRequest, null, 2));
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, "patch-response.json"), JSON.stringify(patch, null, 2));
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, "applied-flow.json"), JSON.stringify(appliedFlow, null, 2));
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, "arm-results.json"), JSON.stringify({ iterN, passCount, failCount }, null, 2));
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, "scores.json"), JSON.stringify({ iterN, passRate, passCount, failCount }, null, 2));
}
// ── report ────────────────────────────────────────────────────────────────────
/**
 * Writes the healing report markdown and returns its path.
 */
function writeHealReport(params) {
    const { outDir, siteId, state, verdict } = params;
    const dir = (0, node_path_1.join)(outDir, siteId);
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
        `# Heal report: ${siteId}`,
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
        `_Generated by recon-heal at ${(0, date_fns_1.formatISO)(new Date())}_`,
        `_Production recon-flow.json was NOT modified. Apply the patch above manually after review._`,
    ].join("\n");
    const reportPath = (0, node_path_1.join)(dir, `healing-${siteId}.md`);
    (0, node_fs_1.writeFileSync)(reportPath, report);
    return reportPath;
}
/**
 * Drives the full baseline → patch → replay → converge loop for a single site.
 * Accepts injectable `stepRunner` and `requestPatchFn` so tests can stub the
 * expensive browser and LLM operations.
 */
async function phaseHeal(params) {
    const { siteId, url, maxIterations = DEFAULT_MAX_ITERATIONS, nReplays = DEFAULT_N_REPLAYS, successThreshold = DEFAULT_SUCCESS_THRESHOLD, plateauDelta = DEFAULT_PLATEAU_DELTA, plateauWindow = DEFAULT_PLATEAU_WINDOW, outDir = DEFAULT_OUT_DIR, dryRun = false, } = params;
    const stepRunner = params.stepRunner ?? (dryRun ? makeDryRunStepRunner() : makeRealStepRunner());
    const requestPatchFn = params.requestPatchFn ?? requestPatch;
    // ── pre-flight ──────────────────────────────────────────────────────────────
    const flowFilePath = (0, node_path_1.resolve)((0, node_path_1.join)("src", "sites", siteId, "recon-flow.json"));
    // recon-heal operates on the instruction strings; per the file-level comment
    // it never writes back to the source flow, so the projection to strings is
    // lossless from recon-heal's perspective even if the source uses the N+23
    // optional-object shape. The shape is validated upstream by recon-browser.
    const rawFlow = JSON.parse((0, node_fs_1.readFileSync)(flowFilePath, "utf-8"));
    const originalFlow = Array.isArray(rawFlow)
        ? rawFlow.map((s) => (typeof s === "string" ? s : s.step))
        : [];
    logger.info(`recon-heal: site=${siteId} flow_steps=${originalFlow.length} url=${url}`);
    const estimatedCalls = (1 + maxIterations) * nReplays * 2;
    if (estimatedCalls > COST_WARNING_THRESHOLD) {
        logger.warn(`recon-heal: estimated ${estimatedCalls} calls (threshold=${COST_WARNING_THRESHOLD}). ` +
            `Reduce --max-iterations or --n-replays to lower cost.`);
    }
    const anthropic = dryRun ? null : buildAnthropicClient();
    if (!dryRun && !anthropic) {
        throw new Error("recon-heal requires ANTHROPIC_API_KEY — Bedrock-only deployments are not supported");
    }
    (0, node_fs_1.mkdirSync)((0, node_path_1.join)(outDir, siteId), { recursive: true });
    // ── baseline ────────────────────────────────────────────────────────────────
    logger.info(`recon-heal: baseline (n_replays=${nReplays})`);
    let baselinePassSum = 0;
    for (let r = 0; r < nReplays; r++) {
        const runId = `heal-baseline-${siteId}-r${r}`;
        const result = await stepRunner({ flow: originalFlow, url, runId });
        baselinePassSum += result.passRate;
        logger.info(`recon-heal: baseline r${r} pass_rate=${(result.passRate * 100).toFixed(0)}%`);
    }
    const baselinePassRate = nReplays > 0 ? baselinePassSum / nReplays : 0;
    logger.info(`recon-heal: baseline avg pass_rate=${(baselinePassRate * 100).toFixed(0)}%`);
    const state = {
        siteId,
        originalFlow,
        baselinePassRate,
        history: [],
        bestPassRate: baselinePassRate,
        bestPatch: null,
        bestIterN: 0,
    };
    writeState(outDir, siteId, state);
    if (baselinePassRate >= successThreshold) {
        logger.info("recon-heal: baseline already meets threshold — exiting SUCCESS");
        const reportPath = writeHealReport({ outDir, siteId, state, verdict: "SUCCESS" });
        return { verdict: "SUCCESS", reportPath, state };
    }
    // ── iteration loop ──────────────────────────────────────────────────────────
    let currentFlow = [...originalFlow];
    let failingSteps = [...originalFlow];
    const priorAttempts = [];
    let convergeResult = "CONTINUE";
    while (convergeResult === "CONTINUE") {
        const iterN = state.history.length + 1;
        logger.info(`recon-heal: iteration ${iterN}/${maxIterations}`);
        const patchRequest = {
            currentFlow,
            failingSteps,
            iterN,
            priorAttempts: [...priorAttempts],
        };
        let patch = null;
        if (anthropic) {
            patch = await requestPatchFn({
                client: anthropic,
                currentFlow,
                failingSteps,
                iterN,
                priorAttempts,
            });
        }
        if (!patch) {
            logger.warn(`recon-heal: iter ${iterN} — patch-generator returned null, stopping`);
            convergeResult = "BUDGET_EXHAUSTED";
            break;
        }
        const appliedFlow = applyPatch(currentFlow, patch);
        let patchedPassSum = 0;
        let totalPassCount = 0;
        let totalFailCount = 0;
        for (let r = 0; r < nReplays; r++) {
            const runId = `heal-iter${iterN}-${siteId}-r${r}`;
            const result = await stepRunner({ flow: appliedFlow, url, runId });
            patchedPassSum += result.passRate;
            totalPassCount += result.passCount;
            totalFailCount += result.failCount;
            logger.info(`recon-heal: iter ${iterN} r${r} pass_rate=${(result.passRate * 100).toFixed(0)}%`);
        }
        const passRate = nReplays > 0 ? patchedPassSum / nReplays : 0;
        const prevBest = state.bestPassRate;
        const record = { iterN, passRate, patch };
        state.history.push(record);
        if (passRate > state.bestPassRate) {
            state.bestPassRate = passRate;
            state.bestPatch = patch;
            state.bestIterN = iterN;
            currentFlow = appliedFlow;
            failingSteps = appliedFlow;
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
        writeIterationArtifacts({
            outDir,
            siteId,
            iterN,
            patchRequest,
            patch,
            appliedFlow,
            passRate,
            passCount: totalPassCount,
            failCount: totalFailCount,
        });
        writeState(outDir, siteId, state);
        logger.info(`recon-heal: iter ${iterN} pass_rate=${(passRate * 100).toFixed(0)}% ` +
            `best=${(state.bestPassRate * 100).toFixed(0)}% outcome=${outcome}`);
        convergeResult = checkConvergence({
            history: state.history,
            bestPassRate: state.bestPassRate,
            maxIterations,
            successThreshold,
            plateauDelta,
            plateauWindow,
        });
    }
    const finalVerdict = convergeResult;
    const reportPath = writeHealReport({ outDir, siteId, state, verdict: finalVerdict });
    logger.info(`recon-heal: verdict=${finalVerdict} report=${reportPath}`);
    return { verdict: finalVerdict, reportPath, state };
}
// ── CLI ───────────────────────────────────────────────────────────────────────
/**
 * Parses CLI args and exits with a usage message when required args are absent.
 */
function parseCli() {
    const args = process.argv.slice(2);
    let siteId = "";
    let url = "";
    let maxIterations = DEFAULT_MAX_ITERATIONS;
    let nReplays = DEFAULT_N_REPLAYS;
    let successThreshold = DEFAULT_SUCCESS_THRESHOLD;
    let plateauDelta = DEFAULT_PLATEAU_DELTA;
    let plateauWindow = DEFAULT_PLATEAU_WINDOW;
    let outDir = DEFAULT_OUT_DIR;
    let dryRun = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--site-id" && args[i + 1])
            siteId = args[++i];
        else if (args[i] === "--url" && args[i + 1])
            url = args[++i];
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
        else if (args[i] === "--dry-run")
            dryRun = true;
    }
    if (!siteId || !url) {
        logger.error("usage: recon-heal.ts --site-id <id> --url <url> [--max-iterations N] [--n-replays N] " +
            "[--success-threshold 0..1] [--plateau-delta 0..1] [--plateau-window N] " +
            "[--out-dir <path>] [--dry-run]");
        process.exit(1);
    }
    return {
        siteId,
        url,
        maxIterations,
        nReplays,
        successThreshold,
        plateauDelta,
        plateauWindow,
        outDir,
        dryRun,
    };
}
async function main() {
    const cliArgs = parseCli();
    const { verdict, reportPath, state } = await phaseHeal(cliArgs);
    logger.info(`recon-heal complete: verdict=${verdict}`);
    logger.info(`recon-heal: best_pass_rate=${(state.bestPassRate * 100).toFixed(0)}%`);
    logger.info(`recon-heal: report written to ${reportPath}`);
}
if (process.argv[1] !== undefined &&
    (process.argv[1].endsWith("recon-heal.ts") || process.argv[1].endsWith("recon-heal.js"))) {
    main().catch((err) => {
        logger.error(`recon-heal failed: ${String(err)}`);
        process.exit(1);
    });
}
//# sourceMappingURL=recon-heal.js.map