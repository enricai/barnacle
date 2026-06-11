"use strict";
/**
 * Error-messages extraction judge. Replaces the framework-conventional
 * regex `errorPattern = /(error-message|mat-error|field-error|...)/` over
 * DOM class signatures.
 *
 * Why: same shape as the invalid-fields judge. The regex covered Angular
 * and Material conventions but missed React Hook Form render-prop errors,
 * headless UI component-based errors, toast-based error notifications,
 * inline tooltip errors, and any site-specific error container class.
 * When the regex missed, the rephrase prompt's VISIBLE ERROR section
 * was `(none)` and the LLM lost the structured field-level rejection
 * messages the server had returned.
 *
 * The judge extracts structurally-marked error messages with optional
 * field hints and severity. Visual-only error styling does NOT count.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ERROR_MESSAGES_SYSTEM_PROMPT = void 0;
exports.judgeErrorMessagesWithLLM = judgeErrorMessagesWithLLM;
const judge_1 = require("../../../lib/llm/judge");
const schemas_1 = require("../../../lib/llm/schemas");
const call_types_1 = require("../../../lib/telemetry/call-types");
const ERROR_MESSAGES_SYSTEM_PROMPT = `You are a strict error-message extractor for browser forms. Given a body-HTML excerpt, identify visible error messages and required-field warnings tied to specific form inputs.

Strict criteria for extracting a message:
- It lives inside a structural error container (class containing "error", "validation", "feedback", "invalid", "required", "help-block-error", "form-error", or app-prefixed equivalent), OR
- It's inside an aria-live="polite" or aria-live="assertive" region, OR
- It's directly adjacent to a field marked aria-invalid="true" or data-invalid.

Do NOT extract:
- Placeholder text inside empty inputs (placeholder= attribute).
- Help text / hint text that's always visible and explains the field (e.g. "Format: MM/DD/YYYY").
- Tooltips that auto-hide on click outside.
- Plain prose text that happens to contain words like "error" but isn't a structural error indicator.

Each message:
- text: the visible message string, trimmed to ≤400 chars.
- fieldHint: a short identifier for the field the error applies to (label text, placeholder, name= attribute, id), or null if not discoverable.
- severity: "error" for structural validation failures, "warning" for soft hints (e.g. "field will be required"), "info" for purely informational adjacent messages.

Return up to 50 messages. Empty array when no structural error containers are visible.`;
exports.ERROR_MESSAGES_SYSTEM_PROMPT = ERROR_MESSAGES_SYSTEM_PROMPT;
function buildErrorMessagesPrompt(input) {
    return `Extract visible structurally-marked error messages from this excerpt.

BODY HTML EXCERPT:
${input.bodyHtmlExcerpt}`;
}
/**
 * Run the error-messages judge. Returns a list of structurally-marked
 * error messages with field hints and severity. Returns null when the
 * client is null (Bedrock-only) or the API call fails — callers fall back
 * to an empty list.
 */
async function judgeErrorMessagesWithLLM(params) {
    const { client, input, captureFn } = params;
    if (client === null)
        return null;
    if (input.bodyHtmlExcerpt.length === 0)
        return null;
    const result = await (0, judge_1.callHaikuJudge)({
        client,
        systemPrompt: ERROR_MESSAGES_SYSTEM_PROMPT,
        userPrompt: buildErrorMessagesPrompt(input),
        schema: schemas_1.ERROR_MESSAGES_SCHEMA,
        callType: call_types_1.CALL_TYPE_JUDGE_ERROR_MESSAGES,
        captureFn,
    });
    return result?.parsed ?? null;
}
//# sourceMappingURL=error-messages.js.map